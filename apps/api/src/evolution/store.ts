// D1 persistence for the Evolution Loop (P3): proposals, tournaments/matches, promotions, canaries,
// operator bandit stats, evolution notes, Glicko-2 ratings and the global tick lock.
// Pure SQL helpers only; orchestration lives in engine.ts.
import type { Env } from "../env";
import { safeJsonParse } from "../util";
import { ThompsonBandit } from "./bandit";
import type { Glicko2Player } from "./rating";

// ---------------------------------------------------------------- proposals
export type ProposalStage = "proposed" | "checked" | "sandboxed" | "tournament" | "canary" | "promoted" | "rolled_back" | "rejected" | "lost";

export interface ProposalRow {
  id: string;
  role: string;
  lineage_id: string;
  genome_id: string | null;
  parent_ids: string[];
  operator: string;
  proposer: string;
  agent_id: string | null;
  stage: ProposalStage;
  reason: string | null;
  note: string | null;
  static_report: any;
  sandbox_report: any;
  tournament_id: string | null;
  decision: any;
  created_at: number;
  updated_at: number;
}

interface ProposalRaw extends Omit<ProposalRow, "parent_ids" | "static_report" | "sandbox_report" | "decision"> {
  parent_ids: string;
  static_report: string | null;
  sandbox_report: string | null;
  decision: string | null;
}

const toProposal = (r: ProposalRaw): ProposalRow => ({
  ...r,
  parent_ids: safeJsonParse<string[]>(r.parent_ids) ?? [],
  static_report: safeJsonParse(r.static_report),
  sandbox_report: safeJsonParse(r.sandbox_report),
  decision: safeJsonParse(r.decision),
});

const js = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export async function insertProposal(
  env: Env,
  p: Pick<ProposalRow, "id" | "role" | "lineage_id" | "genome_id" | "parent_ids" | "operator" | "proposer" | "agent_id" | "stage" | "reason" | "note">,
  at = Date.now(),
): Promise<ProposalRow> {
  await env.DB.prepare(
    `INSERT INTO proposals (id, role, lineage_id, genome_id, parent_ids, operator, proposer, agent_id, stage, reason, note, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
  )
    .bind(p.id, p.role, p.lineage_id, p.genome_id, JSON.stringify(p.parent_ids), p.operator, p.proposer, p.agent_id, p.stage, p.reason, p.note, at)
    .run();
  return (await getProposal(env, p.id))!;
}

export async function getProposal(env: Env, id: string): Promise<ProposalRow | null> {
  const r = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?1").bind(id).first<ProposalRaw>();
  return r ? toProposal(r) : null;
}

export async function listProposals(env: Env, f: { role?: string; stage?: ProposalStage; limit?: number } = {}): Promise<ProposalRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.role) where.push(`role = ?${args.push(f.role)}`);
  if (f.stage) where.push(`stage = ?${args.push(f.stage)}`);
  const sql = `SELECT * FROM proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ${Math.max(1, Math.min(500, f.limit ?? 100))}`;
  return (await env.DB.prepare(sql).bind(...args).all<ProposalRaw>()).results.map(toProposal);
}

export type ProposalPatch = Partial<Pick<ProposalRow, "stage" | "reason" | "note" | "static_report" | "sandbox_report" | "tournament_id" | "decision" | "genome_id" | "agent_id">>;

export async function updateProposal(env: Env, id: string, patch: ProposalPatch): Promise<void> {
  const JSON_COLS = new Set(["static_report", "sandbox_report", "decision"]);
  const keys = Object.keys(patch) as (keyof ProposalPatch)[];
  if (!keys.length) return;
  const sets = keys.map((k, n) => `${k} = ?${n + 2}`).join(", ");
  const vals = keys.map((k) => (JSON_COLS.has(k) ? js(patch[k]) : (patch[k] ?? null)));
  await env.DB.prepare(`UPDATE proposals SET ${sets}, updated_at = ?${keys.length + 2} WHERE id = ?1`)
    .bind(id, ...vals, Date.now())
    .run();
}

// ---------------------------------------------------------------- operator bandit (per role)
export interface OperatorStat {
  role: string;
  operator: string;
  alpha: number;
  beta: number;
  trials: number;
  wins: number;
  updated_at: number;
}

export async function operatorStats(env: Env, role?: string): Promise<OperatorStat[]> {
  const q = role
    ? env.DB.prepare("SELECT * FROM operator_stats WHERE role = ?1 ORDER BY operator").bind(role)
    : env.DB.prepare("SELECT * FROM operator_stats ORDER BY role, operator");
  return (await q.all<OperatorStat>()).results;
}

/** Bandit over `arms` for a role, posterior restored from operator_stats (missing arms start at the prior). */
export async function loadBandit(env: Env, role: string, arms: readonly string[]): Promise<ThompsonBandit> {
  const rows = await operatorStats(env, role);
  const json = { prior: { alpha: 1, beta: 1 }, arms: {} as Record<string, { alpha: number; beta: number }> };
  for (const a of arms) json.arms[a] = { alpha: 1, beta: 1 };
  for (const r of rows) if (arms.includes(r.operator) && r.alpha > 0 && r.beta > 0) json.arms[r.operator] = { alpha: r.alpha, beta: r.beta };
  return ThompsonBandit.fromJSON(json);
}

/** Record one Bernoulli outcome for (role, operator). Atomic upsert. */
export async function recordOperatorOutcome(env: Env, role: string, operator: string, success: boolean, at = Date.now()): Promise<void> {
  const s = success ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO operator_stats (role, operator, alpha, beta, trials, wins, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
     ON CONFLICT(role, operator) DO UPDATE SET alpha = operator_stats.alpha + ?5, beta = operator_stats.beta + (1 - ?5),
       trials = operator_stats.trials + 1, wins = operator_stats.wins + ?5, updated_at = excluded.updated_at`,
  )
    .bind(role, operator, 1 + s, 2 - s, s, at)
    .run();
}

// ---------------------------------------------------------------- evolution notes
export interface EvolutionNote {
  id: number;
  role: string;
  operator: string;
  genome_id: string | null;
  outcome: string;
  note: string;
  delta: number | null;
  at: number;
}

export async function addNote(env: Env, n: Omit<EvolutionNote, "id" | "at"> & { at?: number }): Promise<void> {
  await env.DB.prepare("INSERT INTO evolution_notes (role, operator, genome_id, outcome, note, delta, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(n.role, n.operator, n.genome_id, n.outcome, n.note.slice(0, 1000), n.delta, n.at ?? Date.now())
    .run();
}

export async function recentNotes(env: Env, role: string, outcomes: string[], limit = 5): Promise<EvolutionNote[]> {
  if (!outcomes.length) return [];
  const ph = outcomes.map((_, i) => `?${i + 2}`).join(",");
  return (
    await env.DB.prepare(`SELECT * FROM evolution_notes WHERE role = ?1 AND outcome IN (${ph}) ORDER BY at DESC, id DESC LIMIT ${Math.max(1, Math.min(50, limit))}`)
      .bind(role, ...outcomes)
      .all<EvolutionNote>()
  ).results;
}

// ---------------------------------------------------------------- tournaments / matches
export interface TournamentRow {
  id: string;
  role: string;
  champion_genome: string;
  participants: { genome_id: string; agent_id: string | null; proposal_id?: string }[];
  items: string[];
  status: "running" | "done" | "aborted";
  summary: any;
  created_at: number;
  finished_at: number | null;
}

export async function insertTournament(env: Env, t: Omit<TournamentRow, "summary" | "finished_at" | "status">): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tournaments (id, role, champion_genome, participants, items, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)",
  )
    .bind(t.id, t.role, t.champion_genome, JSON.stringify(t.participants), JSON.stringify(t.items), t.created_at)
    .run();
}

export async function finishTournament(env: Env, id: string, status: "done" | "aborted", summary: unknown): Promise<void> {
  await env.DB.prepare("UPDATE tournaments SET status = ?2, summary = ?3, finished_at = ?4 WHERE id = ?1").bind(id, status, js(summary), Date.now()).run();
}

export async function getTournament(env: Env, id: string): Promise<TournamentRow | null> {
  const r = await env.DB.prepare("SELECT * FROM tournaments WHERE id = ?1").bind(id).first<any>();
  if (!r) return null;
  return { ...r, participants: safeJsonParse(r.participants) ?? [], items: safeJsonParse(r.items) ?? [], summary: safeJsonParse(r.summary) };
}

export interface MatchRow {
  id?: number;
  tournament_id: string;
  item_id: string;
  a_genome: string;
  b_genome: string;
  outcome: number; // a's score
  method: string;
  agreement: number;
  detail: string | null;
  at: number;
}

export async function insertMatches(env: Env, rows: MatchRow[]): Promise<void> {
  if (!rows.length) return;
  const stmt = env.DB.prepare(
    "INSERT INTO matches (tournament_id, item_id, a_genome, b_genome, outcome, method, agreement, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  );
  for (let i = 0; i < rows.length; i += 50)
    await env.DB.batch(rows.slice(i, i + 50).map((m) => stmt.bind(m.tournament_id, m.item_id, m.a_genome, m.b_genome, m.outcome, m.method, m.agreement, m.detail, m.at)));
}

export async function matchesOf(env: Env, tournamentId: string): Promise<MatchRow[]> {
  return (await env.DB.prepare("SELECT * FROM matches WHERE tournament_id = ?1 ORDER BY id").bind(tournamentId).all<MatchRow>()).results;
}

// ---------------------------------------------------------------- ratings (Glicko-2 on elo_ratings)
export async function loadRatings(env: Env, genomeIds: string[]): Promise<Record<string, Glicko2Player>> {
  const out: Record<string, Glicko2Player> = {};
  if (!genomeIds.length) return out;
  const ph = genomeIds.map((_, i) => `?${i + 1}`).join(",");
  const rows = (
    await env.DB.prepare(`SELECT genome_id, rating, rd, vol FROM elo_ratings WHERE genome_id IN (${ph})`)
      .bind(...genomeIds)
      .all<{ genome_id: string; rating: number; rd: number; vol: number }>()
  ).results;
  for (const r of rows) out[r.genome_id] = { r: r.rating, rd: r.rd, vol: r.vol };
  return out;
}

export async function saveRatings(env: Env, role: string, ratings: Record<string, Glicko2Player>, games: Record<string, number>): Promise<void> {
  const ids = Object.keys(ratings);
  if (!ids.length) return;
  const at = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO elo_ratings (genome_id, role, rating, rd, vol, matches, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(genome_id) DO UPDATE SET rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
       matches = elo_ratings.matches + excluded.matches, updated_at = excluded.updated_at`,
  );
  await env.DB.batch(ids.map((id) => stmt.bind(id, role, ratings[id]!.r, ratings[id]!.rd, ratings[id]!.vol, games[id] ?? 0, at)));
}

// ---------------------------------------------------------------- promotions
export type PromotionKind = "canary_start" | "promote" | "auto_rollback" | "owner_rollback";
export interface PromotionRow {
  id: string;
  role: string;
  kind: PromotionKind;
  from_genome: string | null;
  to_genome: string | null;
  from_agent: string | null;
  to_agent: string | null;
  proposal_id: string | null;
  reason: string | null;
  detail: any;
  actor: string;
  at: number;
}

export async function insertPromotion(env: Env, p: Omit<PromotionRow, "at"> & { at?: number }): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO promotions (id, role, kind, from_genome, to_genome, from_agent, to_agent, proposal_id, reason, detail, actor, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
  )
    .bind(p.id, p.role, p.kind, p.from_genome, p.to_genome, p.from_agent, p.to_agent, p.proposal_id, p.reason, js(p.detail), p.actor, p.at ?? Date.now())
    .run();
}

export async function listPromotions(env: Env, role?: string, limit = 100): Promise<PromotionRow[]> {
  const lim = Math.max(1, Math.min(500, limit));
  const q = role
    ? env.DB.prepare(`SELECT * FROM promotions WHERE role = ?1 ORDER BY at DESC, rowid DESC LIMIT ${lim}`).bind(role)
    : env.DB.prepare(`SELECT * FROM promotions ORDER BY at DESC, rowid DESC LIMIT ${lim}`);
  return (await q.all<any>()).results.map((r) => ({ ...r, detail: safeJsonParse(r.detail) }));
}

// ---------------------------------------------------------------- canaries
export interface CanaryRow {
  id: string;
  role: string;
  proposal_id: string;
  candidate_agent: string;
  candidate_genome: string;
  champion_agent: string;
  champion_genome: string;
  traffic_pct: number;
  status: "running" | "promoted" | "rolled_back";
  obs: number;
  cand_pass: number;
  champ_pass: number;
  reason: string | null;
  started_at: number;
  decided_at: number | null;
}

export async function insertCanary(env: Env, c: Omit<CanaryRow, "status" | "obs" | "cand_pass" | "champ_pass" | "reason" | "decided_at">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO canaries (id, role, proposal_id, candidate_agent, candidate_genome, champion_agent, champion_genome, traffic_pct, status, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', ?9)`,
  )
    .bind(c.id, c.role, c.proposal_id, c.candidate_agent, c.candidate_genome, c.champion_agent, c.champion_genome, c.traffic_pct, c.started_at)
    .run();
}

export async function getCanary(env: Env, id: string): Promise<CanaryRow | null> {
  return env.DB.prepare("SELECT * FROM canaries WHERE id = ?1").bind(id).first<CanaryRow>();
}

export async function runningCanaries(env: Env, role?: string): Promise<CanaryRow[]> {
  const q = role
    ? env.DB.prepare("SELECT * FROM canaries WHERE status = 'running' AND role = ?1 ORDER BY started_at").bind(role)
    : env.DB.prepare("SELECT * FROM canaries WHERE status = 'running' ORDER BY started_at");
  return (await q.all<CanaryRow>()).results;
}

/** Add paired observations (atomic increments). */
export async function addCanaryObs(env: Env, id: string, obs: number, candPass: number, champPass: number): Promise<void> {
  await env.DB.prepare("UPDATE canaries SET obs = obs + ?2, cand_pass = cand_pass + ?3, champ_pass = champ_pass + ?4 WHERE id = ?1 AND status = 'running'")
    .bind(id, obs, candPass, champPass)
    .run();
}

/** Close a running canary. Returns false if it was already decided (so the caller does not act twice). */
export async function decideCanary(env: Env, id: string, status: "promoted" | "rolled_back", reason: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE canaries SET status = ?2, reason = ?3, decided_at = ?4 WHERE id = ?1 AND status = 'running'")
    .bind(id, status, reason.slice(0, 500), Date.now())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- global tick lock (governor_state row with expiry)
export const LOCK_KEY = "evolution.lock";
export const RR_KEY = "evolution.rr";

/** Take the global evolution lock unless someone holds an unexpired one. Atomic (single upsert). */
export async function acquireLock(env: Env, holder: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const value = JSON.stringify({ holder, expires_at: now + Math.max(1000, ttlMs) });
  const r = await env.DB.prepare(
    `INSERT INTO governor_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE COALESCE(json_extract(governor_state.value, '$.expires_at'), 0) < ?3
     RETURNING key`,
  )
    .bind(LOCK_KEY, value, now)
    .first<{ key: string }>();
  return r !== null;
}

/** Extend a lock this holder already owns (false if it expired and someone else took it). */
export async function renewLock(env: Env, holder: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const value = JSON.stringify({ holder, expires_at: now + Math.max(1000, ttlMs) });
  const r = await env.DB.prepare("UPDATE governor_state SET value = ?2, updated_at = ?3 WHERE key = ?1 AND json_extract(value, '$.holder') = ?4 RETURNING key")
    .bind(LOCK_KEY, value, now, holder)
    .first<{ key: string }>();
  return r !== null;
}

export async function releaseLock(env: Env, holder: string): Promise<void> {
  await env.DB.prepare("DELETE FROM governor_state WHERE key = ?1 AND json_extract(value, '$.holder') = ?2").bind(LOCK_KEY, holder).run();
}

export async function lockState(env: Env): Promise<{ holder: string; expires_at: number } | null> {
  const r = await env.DB.prepare("SELECT value FROM governor_state WHERE key = ?1").bind(LOCK_KEY).first<{ value: string }>();
  return safeJsonParse(r?.value ?? null);
}
