/**
 * Owner-only Evolution Loop API, mounted at /api/evolution by index.ts (behind the owner gate + x-khaliya CSRF
 * header). Read views over proposals / tournaments / ratings / promotions / operator bandit / notes, and owner
 * actions (tick, one generation, canary evaluation, rollback, reject). LLM work goes through LabLLM (kill switch,
 * per-request call budget, daily lab ledger). Errors: EngineError and LabBudgetError are mapped in index.ts
 * (404/400/409, 429 lab_tick/lab_daily, 423 lab_killed).
 *
 * Mutating actions that drive the engine (tick, generation, canary evaluate, reject) hold the global evolution
 * lock (governor_state `evolution.lock`) so they never race a cron tick; a held lock → 409 {status:"locked"}.
 * Owner rollback deliberately does NOT wait for the lock: it is the owner's safety lever.
 */
import { Hono, type Context } from "hono";
import { audit } from "../audit";
import { ROLES, type Role } from "../constitution";
import type { Env } from "../env";
import { labFor } from "../eval/routes";
import { Governor } from "../governor/governor";
import { Registry } from "../registry/registry";
import { newId, safeJsonParse } from "../util";
import { championOf, evaluateCanary, genomeDiff, ownerRollback, runGeneration, tick, type TickOptions } from "./engine";
import { OPERATORS, type OperatorId } from "./operators";
import { generationJobInit, tickJobInit } from "../jobs/handlers";
import { jobAccepted, startJob } from "../jobs/routes";
import {
  acquireLock,
  addNote,
  decideCanary,
  getCanary,
  getProposal,
  getTournament,
  listPromotions,
  lockState,
  matchesOf,
  operatorStats,
  releaseLock,
  runningCanaries,
  updateProposal,
  type CanaryRow,
  type ProposalRow,
  type ProposalStage,
} from "./store";

type R = { Bindings: Env };
export const evolutionRoutes = new Hono<R>();

/** Default per-request LLM call ceilings for owner-triggered evolution work. */
export const EVOLUTION_CALLS = { tick: 400, generation: 400, canary: 150 } as const;
const OWNER_LOCK_TTL = 15 * 60_000;

const STAGES: ProposalStage[] = ["proposed", "checked", "sandboxed", "tournament", "canary", "promoted", "rolled_back", "rejected", "lost"];
const OPEN_STAGES: ProposalStage[] = ["proposed", "checked", "sandboxed", "tournament"];
const TERMINAL_STAGES: ProposalStage[] = ["promoted", "rolled_back", "rejected", "lost"];

/** Coarse status the console shows: open while in the pipeline, else the terminal/canary stage itself. */
export const proposalStatus = (stage: ProposalStage): string => (OPEN_STAGES.includes(stage) ? "open" : stage);

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clampCalls = (v: unknown, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), def * 5) : def;
};
const lim = (v: string | undefined, def: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : def;
};
const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as string[]).includes(r);
const badRole = (c: Context<R>, r: unknown) => c.json({ error: `unknown role '${String(r)}'`, roles: ROLES }, 400);
const body = async <T,>(c: Context<R>): Promise<T> => c.req.json<T>().catch(() => ({}) as T);

async function activeLock(env: Env) {
  const l = await lockState(env);
  return l && l.expires_at > Date.now() ? l : null;
}

/** Run `fn` holding the global evolution lock (owner holder id), or answer 409 locked. */
async function withLock(c: Context<R>, label: string, fn: () => Promise<Response>): Promise<Response> {
  const holder = `owner:${label}:${newId("lk")}`;
  if (!(await acquireLock(c.env, holder, OWNER_LOCK_TTL))) return c.json({ status: "locked", error: "evolution is busy (lock held)", lock: await activeLock(c.env) }, 409);
  try {
    return await fn();
  } finally {
    await releaseLock(c.env, holder);
  }
}

async function killedResponse(c: Context<R>) {
  if ((await new Governor(c.env).isKilled()).killed) return c.json({ status: "killed", error: "global kill switch is ON", code: "lab_killed" }, 423);
  return null;
}

// ---------------------------------------------------------------- shaping

function scoresOf(p: ProposalRow) {
  const sb = p.sandbox_report;
  const d = p.decision;
  const rv = p.static_report?.review;
  const h2h = d?.head_to_head;
  return {
    risk: typeof rv?.risk === "number" ? rv.risk : null,
    sandbox: sb ? { public: sb.public ?? null, canary: sb.canary ? { n: sb.canary.n, candidate: sb.canary.candidate, champion: sb.canary.champion } : null, cost: sb.cost ?? null } : null,
    tournament: h2h
      ? { wins: h2h.wins, losses: h2h.losses, draws: h2h.draws, games: h2h.games, win_rate: typeof d.winRate === "number" ? r3(d.winRate) : null, wilson_lower: typeof d.wilsonLower === "number" ? r3(d.wilsonLower) : null }
      : null,
    gate_pass: typeof d?.pass === "boolean" ? d.pass : null,
  };
}

function reasonsOf(p: ProposalRow): string[] {
  const out: string[] = [];
  if (p.reason) out.push(p.reason);
  const gateReasons = Array.isArray(p.decision?.reasons) ? (p.decision.reasons as unknown[]).filter((x): x is string => typeof x === "string") : [];
  for (const r of gateReasons) if (!out.some((o) => o.includes(r))) out.push(r);
  return out;
}

export function shapeProposal(p: ProposalRow) {
  return {
    id: p.id,
    role: p.role,
    operator: p.operator,
    parent_genome_id: p.parent_ids[0] ?? null,
    genome_id: p.genome_id,
    status: proposalStatus(p.stage),
    stage: p.stage,
    reasons: reasonsOf(p),
    scores: scoresOf(p),
    created_at: p.created_at,
    updated_at: p.updated_at,
    // extras (not required by the contract, handy for the console)
    agent_id: p.agent_id,
    lineage_id: p.lineage_id,
    proposer: p.proposer,
    note: p.note,
    tournament_id: p.tournament_id,
  };
}

function shapeCanary(c: CanaryRow) {
  return {
    id: c.id,
    proposal_id: c.proposal_id,
    candidate_agent: c.candidate_agent,
    candidate_genome: c.candidate_genome,
    champion_agent: c.champion_agent,
    champion_genome: c.champion_genome,
    traffic_pct: c.traffic_pct,
    status: c.status,
    obs: c.obs,
    candidate_score: c.obs ? r3(c.cand_pass / c.obs) : null,
    champion_score: c.obs ? r3(c.champ_pass / c.obs) : null,
    reason: c.reason,
    started_at: c.started_at,
    decided_at: c.decided_at,
  };
}

const conservative = (rating: number, rd: number) => r3(rating - 2 * rd);

async function lastTick(env: Env) {
  const r = await env.DB.prepare("SELECT at, actor, detail FROM audit WHERE action = 'evolution.tick' ORDER BY seq DESC LIMIT 1").first<{ at: number; actor: string; detail: string | null }>();
  if (!r) return null;
  return { at: r.at, actor: r.actor, ...(safeJsonParse<Record<string, unknown>>(r.detail) ?? {}) };
}

// ---------------------------------------------------------------- status

evolutionRoutes.get("/status", async (c) => {
  const env = c.env;
  const gov = new Governor(env);
  const deployed = (await env.DB.prepare("SELECT DISTINCT role FROM deployments WHERE active = 1 ORDER BY role").all<{ role: string }>()).results.map((r) => r.role);
  const canaries = await runningCanaries(env);
  const candCounts = Object.fromEntries(
    (await env.DB.prepare("SELECT role, COUNT(*) AS n FROM agents WHERE status IN ('candidate','sandboxed') GROUP BY role").all<{ role: string; n: number }>()).results.map((r) => [r.role, r.n]),
  );
  const roles = [];
  for (const role of deployed) {
    const ch = await championOf(env, role);
    if (!ch) continue;
    const er = await env.DB.prepare("SELECT rating, rd FROM elo_ratings WHERE genome_id = ?1").bind(ch.genome.id).first<{ rating: number; rd: number }>();
    const can = canaries.find((x) => x.role === role);
    roles.push({
      role,
      champion: { agent_id: ch.agent.id, genome_id: ch.genome.id, version: ch.genome.version, rating: er ? r3(er.rating) : null, rd: er ? r3(er.rd) : null },
      canary: can ? shapeCanary(can) : null,
      candidates_count: candCounts[role] ?? 0,
    });
  }
  return c.json({
    lock: await activeLock(env),
    kill_global: (await gov.isKilled()).killed,
    roles,
    last_tick: await lastTick(env),
    auto: (env.EVOLUTION_AUTO ?? "off") === "on",
  });
});

// ---------------------------------------------------------------- proposals

evolutionRoutes.get("/proposals", async (c) => {
  const role = c.req.query("role") || undefined;
  const status = c.req.query("status") || undefined;
  if (role && !isRole(role)) return badRole(c, role);
  const where: string[] = [];
  const args: unknown[] = [];
  if (role) where.push(`role = ?${args.push(role)}`);
  if (status) {
    let stages: ProposalStage[];
    if (status === "open") stages = OPEN_STAGES;
    else if (status === "closed") stages = TERMINAL_STAGES;
    else if ((STAGES as string[]).includes(status)) stages = [status as ProposalStage];
    else return c.json({ error: `unknown status '${status}'`, statuses: ["open", "closed", ...STAGES] }, 400);
    where.push(`stage IN (${stages.map((s) => `?${args.push(s)}`).join(",")})`);
  }
  const sql = `SELECT * FROM proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ${lim(c.req.query("limit"), 100, 500)}`;
  const rows = (await c.env.DB.prepare(sql).bind(...args).all<{ id: string }>()).results;
  const out = [];
  for (const r of rows) {
    const p = await getProposal(c.env, r.id); // one parser for JSON columns
    if (p) out.push(shapeProposal(p));
  }
  return c.json({ proposals: out });
});

evolutionRoutes.get("/proposals/:id", async (c) => {
  const p = await getProposal(c.env, c.req.param("id"));
  if (!p) return c.json({ error: "not found" }, 404);
  const reg = new Registry(c.env);
  const genome = p.genome_id ? await reg.getGenome(p.genome_id) : null;
  const parent = p.parent_ids[0] ? await reg.getGenome(p.parent_ids[0]) : null;
  const tournament = p.tournament_id ? await getTournament(c.env, p.tournament_id) : null;
  const matches = tournament ? await matchesOf(c.env, tournament.id) : [];
  return c.json({
    proposal: { ...shapeProposal(p), parent_ids: p.parent_ids, static_report: p.static_report, sandbox_report: p.sandbox_report, decision: p.decision },
    genome,
    parent_genome: parent,
    diff: genome ? genomeDiff(parent, genome) : null,
    tournament,
    matches: matches.map(shapeMatch),
  });
});

evolutionRoutes.post("/proposals/:id/reject", async (c) => {
  const id = c.req.param("id");
  const b = await body<{ reason?: string }>(c);
  const p0 = await getProposal(c.env, id);
  if (!p0) return c.json({ error: "not found" }, 404);
  if (TERMINAL_STAGES.includes(p0.stage)) return c.json({ error: `proposal is already ${p0.stage}`, code: "bad_state" }, 409);
  return withLock(c, "reject", async () => {
    const p = (await getProposal(c.env, id))!;
    if (TERMINAL_STAGES.includes(p.stage)) return c.json({ error: `proposal is already ${p.stage}`, code: "bad_state" }, 409);
    const reason = `owner: ${String(b.reason ?? "rejected by owner").slice(0, 300)}`;
    let canaryId: string | null = null;
    if (p.stage === "canary") {
      const [can] = (await runningCanaries(c.env, p.role)).filter((x) => x.proposal_id === p.id);
      // No promotions row: the pointer never moved. The canary row itself records the owner's reason.
      if (can && (await decideCanary(c.env, can.id, "rolled_back", reason))) canaryId = can.id;
    }
    await updateProposal(c.env, p.id, { stage: "rejected", reason });
    if (p.agent_id) {
      const reg = new Registry(c.env);
      const a = await reg.getAgent(p.agent_id);
      if (a && a.status !== "retired" && a.status !== "champion") await reg.setStatus(a.id, "retired", "owner");
    }
    await addNote(c.env, { role: p.role, operator: p.operator, genome_id: p.genome_id, outcome: "rejected", note: `${p.operator}: ${p.note ?? ""} — rejected by the owner (${reason})`, delta: null });
    await audit(c.env.DB, "owner", "evolution.owner_reject", p.id, { from_stage: p.stage, genome: p.genome_id, canary: canaryId, reason });
    return c.json({ proposal: shapeProposal((await getProposal(c.env, p.id))!), canary_closed: canaryId });
  });
});

// ---------------------------------------------------------------- leaderboard

evolutionRoutes.get("/leaderboard", async (c) => {
  const role = c.req.query("role") || undefined;
  if (role && !isRole(role)) return badRole(c, role);
  const rows = (
    await (role
      ? c.env.DB.prepare(
          `SELECT e.genome_id, e.role, e.rating, e.rd, e.vol, e.matches, g.version FROM elo_ratings e LEFT JOIN genomes g ON g.id = e.genome_id WHERE e.role = ?1`,
        ).bind(role)
      : c.env.DB.prepare(`SELECT e.genome_id, e.role, e.rating, e.rd, e.vol, e.matches, g.version FROM elo_ratings e LEFT JOIN genomes g ON g.id = e.genome_id`)
    ).all<{ genome_id: string; role: string; rating: number; rd: number; vol: number; matches: number; version: number | null }>()
  ).results;
  // Agent per genome: prefer a live one (champion > candidate > other), else the latest retired one.
  const rank: Record<string, number> = { champion: 0, candidate: 1, sandboxed: 2, draft: 3, quarantined: 4, retired: 5 };
  const agents = (await c.env.DB.prepare("SELECT id, genome_id, status, updated_at FROM agents").all<{ id: string; genome_id: string; status: string; updated_at: number }>()).results;
  const best = new Map<string, { id: string; status: string; updated_at: number }>();
  for (const a of agents) {
    const cur = best.get(a.genome_id);
    if (!cur || (rank[a.status] ?? 9) < (rank[cur.status] ?? 9) || ((rank[a.status] ?? 9) === (rank[cur.status] ?? 9) && a.updated_at > cur.updated_at)) best.set(a.genome_id, a);
  }
  const ratings = rows
    .map((r) => {
      const a = best.get(r.genome_id);
      return {
        genome_id: r.genome_id,
        agent_id: a?.id ?? null,
        role: r.role,
        version: r.version,
        rating: r3(r.rating),
        rd: r3(r.rd),
        vol: r.vol,
        matches: r.matches,
        conservative: conservative(r.rating, r.rd),
        status: a?.status ?? "no_agent",
      };
    })
    .sort((x, y) => y.conservative - x.conservative || y.rating - x.rating);
  return c.json({ ratings });
});

// ---------------------------------------------------------------- tournaments

function shapeMatch(m: { id?: number; item_id: string; a_genome: string; b_genome: string; outcome: number; method: string; agreement: number; detail: string | null; at: number; tournament_id: string }) {
  return { ...m, detail: safeJsonParse(m.detail) };
}

evolutionRoutes.get("/tournaments", async (c) => {
  const role = c.req.query("role") || undefined;
  if (role && !isRole(role)) return badRole(c, role);
  const n = lim(c.req.query("limit"), 50, 200);
  const q = role
    ? c.env.DB.prepare(`SELECT t.*, (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id) AS match_count FROM tournaments t WHERE t.role = ?1 ORDER BY t.created_at DESC LIMIT ${n}`).bind(role)
    : c.env.DB.prepare(`SELECT t.*, (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id) AS match_count FROM tournaments t ORDER BY t.created_at DESC LIMIT ${n}`);
  const rows = (await q.all<any>()).results;
  return c.json({
    tournaments: rows.map((t) => ({ ...t, participants: safeJsonParse(t.participants) ?? [], items: safeJsonParse(t.items) ?? [], summary: safeJsonParse(t.summary) })),
  });
});

evolutionRoutes.get("/tournaments/:id", async (c) => {
  const t = await getTournament(c.env, c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  const proposal = (await c.env.DB.prepare("SELECT id FROM proposals WHERE tournament_id = ?1 LIMIT 1").bind(t.id).first<{ id: string }>())?.id ?? null;
  return c.json({ tournament: t, proposal_id: proposal, matches: (await matchesOf(c.env, t.id)).map(shapeMatch) });
});

// ---------------------------------------------------------------- promotions / operators / notes

evolutionRoutes.get("/promotions", async (c) => {
  const role = c.req.query("role") || undefined;
  if (role && !isRole(role)) return badRole(c, role);
  return c.json({ promotions: await listPromotions(c.env, role, lim(c.req.query("limit"), 100, 500)) });
});

evolutionRoutes.get("/operators", async (c) => {
  const role = c.req.query("role") || undefined;
  if (role && !isRole(role)) return badRole(c, role);
  const rows = await operatorStats(c.env, role);
  const operators = OPERATORS.map((id) => {
    const mine = rows.filter((r) => r.operator === id);
    // Per role: the stored Beta posterior. Across roles: Beta(1 + wins, 1 + losses) over all roles' trials.
    const trials = mine.reduce((s, r) => s + r.trials, 0);
    const wins = mine.reduce((s, r) => s + r.wins, 0);
    const alpha = role && mine[0] ? mine[0].alpha : 1 + wins;
    const beta = role && mine[0] ? mine[0].beta : 1 + (trials - wins);
    return { id, alpha, beta, mean: r3(alpha / (alpha + beta)), trials, wins, roles: mine.map((r) => r.role) };
  });
  return c.json({ role: role ?? null, operators });
});

evolutionRoutes.get("/notes", async (c) => {
  const role = c.req.query("role") || undefined;
  if (role && !isRole(role)) return badRole(c, role);
  const outcome = c.req.query("outcome") || undefined;
  const where: string[] = [];
  const args: unknown[] = [];
  if (role) where.push(`role = ?${args.push(role)}`);
  if (outcome) where.push(`outcome = ?${args.push(outcome)}`);
  const sql = `SELECT * FROM evolution_notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ${lim(c.req.query("limit"), 50, 500)}`;
  return c.json({ notes: (await c.env.DB.prepare(sql).bind(...args).all()).results });
});

// ---------------------------------------------------------------- actions

/**
 * Tick and generation run as background jobs by default (202 {job_id, job, poll}); `{"sync": true}` keeps the
 * single-request behaviour. Validation errors (400), the kill switch (423) and a held lock (409) are still
 * answered synchronously, before any job is created.
 */
evolutionRoutes.post("/tick", async (c) => {
  const b = await body<{ roles?: unknown; max_proposals?: unknown; max_calls?: unknown; sync?: unknown }>(c);
  let roles: Role[] | undefined;
  if (b.roles !== undefined) {
    if (!Array.isArray(b.roles) || !b.roles.every(isRole)) return c.json({ error: "roles must be an array of known roles", roles: ROLES }, 400);
    roles = b.roles as Role[];
  }
  const mp = b.max_proposals === undefined ? 1 : Number(b.max_proposals);
  if (!Number.isFinite(mp) || mp < 0 || mp > 5) return c.json({ error: "max_proposals: 0-5" }, 400);
  const maxCalls = clampCalls(b.max_calls, EVOLUTION_CALLS.tick);
  if (b.sync === true) {
    const lab = labFor(c.env, maxCalls);
    const opts: TickOptions = { maxProposals: Math.floor(mp), roles, holder: `owner:tick:${newId("lk")}` };
    const s = await tick(c.env, lab, opts); // tick takes the lock itself and audits evolution.tick
    if (s.status === "locked") return c.json({ ...s, error: "evolution is busy (lock held)", lock: await activeLock(c.env) }, 409);
    if (s.status === "killed") return c.json({ ...s, error: "global kill switch is ON", code: "lab_killed" }, 423);
    await audit(c.env.DB, "owner", "evolution.tick.manual", null, { roles: roles ?? null, max_proposals: opts.maxProposals, generations: s.generations.length, stopped: s.stopped ?? null });
    return c.json(s);
  }
  const killed = await killedResponse(c);
  if (killed) return killed;
  const lock = await activeLock(c.env);
  if (lock && !lock.holder.startsWith("job:")) return c.json({ status: "locked", error: "evolution is busy (lock held)", lock }, 409);
  const init = tickJobInit(roles, Math.floor(mp));
  const { job, reused } = await startJob(c.env, { kind: "evolution.tick", params: { roles: roles ?? null, max_proposals: Math.floor(mp), max_calls: maxCalls }, state: init.state, total: init.total, max_calls: maxCalls, dedupe_key: "evolution.tick" });
  return c.json(jobAccepted(job, reused), 202);
});

evolutionRoutes.post("/generation", async (c) => {
  const b = await body<{ role?: unknown; operator?: unknown; max_calls?: unknown; sync?: unknown }>(c);
  if (!isRole(b.role)) return badRole(c, b.role);
  if (b.operator !== undefined && !(OPERATORS as readonly string[]).includes(String(b.operator))) return c.json({ error: `unknown operator '${String(b.operator)}'`, operators: OPERATORS }, 400);
  const killed = await killedResponse(c);
  if (killed) return killed;
  const role = b.role;
  const maxCalls = clampCalls(b.max_calls, EVOLUTION_CALLS.generation);
  if (b.sync === true) {
    return withLock(c, "generation", async () => {
      const lab = labFor(c.env, maxCalls);
      const g = await runGeneration(c.env, lab, { role, seed: `owner:${Date.now()}`, operator: b.operator as OperatorId | undefined });
      await audit(c.env.DB, "owner", "evolution.generation", g.proposal_id, { role, operator: g.operator, outcome: g.outcome, llm_calls: g.llm_calls });
      return c.json(g);
    });
  }
  const jobId = newId("job");
  const init = await generationJobInit(c.env, jobId, role, b.operator as OperatorId | undefined); // takes the evolution lock for the job
  if (!init) return c.json({ status: "locked", error: "evolution is busy (lock held)", lock: await activeLock(c.env) }, 409);
  const { job, reused } = await startJob(c.env, { id: jobId, kind: "evolution.generation", params: { role, operator: b.operator ?? null, max_calls: maxCalls }, state: init.state, total: init.total, max_calls: maxCalls });
  return c.json(jobAccepted(job, reused), 202);
});

evolutionRoutes.post("/canaries/:id/evaluate", async (c) => {
  const id = c.req.param("id");
  const b = await body<{ samples?: unknown; max_calls?: unknown }>(c);
  if (!(await getCanary(c.env, id))) return c.json({ error: "not found" }, 404);
  const killed = await killedResponse(c);
  if (killed) return killed;
  const samples = b.samples === undefined ? undefined : Math.max(0, Math.min(20, Math.floor(Number(b.samples)) || 0));
  return withLock(c, "canary", async () => {
    const lab = labFor(c.env, clampCalls(b.max_calls, EVOLUTION_CALLS.canary));
    const d = await evaluateCanary(c.env, lab, id, samples === undefined ? {} : { samples });
    await audit(c.env.DB, "owner", "evolution.canary_evaluate", id, { status: d.status, obs: d.obs, llm_calls: lab.calls });
    return c.json({ ...d, canary: shapeCanary((await getCanary(c.env, id))!), llm_calls: lab.calls });
  });
});

evolutionRoutes.post("/rollback", async (c) => {
  const b = await body<{ role?: unknown; to_genome_id?: unknown }>(c);
  if (!isRole(b.role)) return badRole(c, b.role);
  if (typeof b.to_genome_id !== "string" || !b.to_genome_id) return c.json({ error: "to_genome_id required" }, 400);
  // ownerRollback writes the owner_rollback promotion row and the evolution.owner_rollback audit entry.
  const r = await ownerRollback(c.env, b.role, b.to_genome_id, "owner");
  return c.json(r);
});

