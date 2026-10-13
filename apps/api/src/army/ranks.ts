/**
 * Ranks R0–R4 (master plan §2.2): promotion from Elo/Glicko rating, eval pass rate, red-team pass rate, Judge Court
 * standing and incident history; automatic demotion on incidents. `evaluateRank` is pure; `reviewRank` gathers the
 * metrics from D1 (read-only on existing tables), writes army_ranks and, on demotion, revokes the agent's live
 * capability tokens and passports. Automatic promotion stops at R2: R3 needs owner acceptance, R4 is owner-only,
 * and no rank ever carries L5 (L5 is an owner grant per mission).
 */
import type { Env } from "../env";
import { armyAudit } from "./audit";
import { type AutonomyLevel } from "./autonomy";
import { divisionForRole, isDivision, type DivisionId } from "./divisions";

export type Rank = "R0" | "R1" | "R2" | "R3" | "R4";
export const RANKS: Rank[] = ["R0", "R1", "R2", "R3", "R4"];
export const rankNum = (r: Rank) => RANKS.indexOf(r);
export const isRank = (s: unknown): s is Rank => typeof s === "string" && (RANKS as string[]).includes(s);

export interface RankDef {
  rank: Rank;
  name_en: string;
  name_ar: string;
  /** Highest autonomy level the rank may hold (L5 is never a rank power). */
  max_autonomy: AutonomyLevel;
  rule: string;
  rule_ar: string;
}

export const RANK_DEFS: readonly RankDef[] = Object.freeze([
  { rank: "R0", name_en: "Recruit", name_ar: "مُجنّد", max_autonomy: "L1", rule: "admitted genome; sandbox only", rule_ar: "جينوم مقبول؛ الحاوية فقط" },
  { rank: "R1", name_en: "Specialist", name_ar: "أخصائي", max_autonomy: "L2", rule: "rating ≥ 1550, RD ≤ 120, ≥ 30 missions/matches, eval pass ≥ 0.7, 0 security incidents", rule_ar: "تقييم ≥ 1550، انحراف ≤ 120، ≥ 30 مهمة/مباراة، نجاح التقييم ≥ 0.7، صفر حوادث أمنية" },
  { rank: "R2", name_en: "Senior", name_ar: "خبير", max_autonomy: "L3", rule: "R1 + rating ≥ 1650, red-team pass ≥ 0.97, Judge Court ≥ 0.8", rule_ar: "R1 + تقييم ≥ 1650، اجتياز الفريق الأحمر ≥ 0.97، محكمة القضاة ≥ 0.8" },
  { rank: "R3", name_en: "Lead", name_ar: "قائد", max_autonomy: "L4", rule: "R2 + rating ≥ 1750, 90 days without incident, owner acceptance", rule_ar: "R2 + تقييم ≥ 1750، 90 يومًا بلا حوادث، وقبول المالك" },
  { rank: "R4", name_en: "Marshal", name_ar: "مارشال", max_autonomy: "L4", rule: "owner decision only", rule_ar: "بقرار المالك فقط" },
].map((d) => Object.freeze(d as RankDef)));

export const RANK_MAP = Object.freeze(Object.fromEntries(RANK_DEFS.map((d) => [d.rank, d])) as Record<Rank, RankDef>);

export const THRESHOLDS = Object.freeze({
  R1: { rating: 1550, rd: 120, matches: 30, eval_pass: 0.7 },
  R2: { rating: 1650, redteam_pass: 0.97, court: 0.8 },
  R3: { rating: 1750, clean_days: 90 },
  weak_verdicts_window_days: 7,
  weak_verdicts_limit: 3,
});

export interface RankMetrics {
  rating: number | null;
  rd: number | null;
  matches: number;
  eval_pass_rate: number | null;
  redteam_pass_rate: number | null;
  court_score: number | null;
  /** All-time security incidents (kind security / honeypot / scope_violation). */
  security_incidents: number;
  /** Days since the last incident of any kind (null = never). */
  days_since_incident: number | null;
  /** Incidents in the last 7 days that trigger demotion. */
  canary_rollbacks_7d: number;
  honeypot_7d: number;
  weak_verdicts_7d: number;
  critical_7d: number;
  owner_accepted: boolean;
}

export interface RankDecision {
  current: Rank;
  /** Highest rank the metrics support (capped by owner gates). */
  eligible: Rank;
  next: Rank;
  change: "promote" | "demote" | "hold";
  reasons: string[];
  /** What is missing for the next rank above `next`. */
  missing: string[];
}

function ruleR1(m: RankMetrics): string[] {
  const t = THRESHOLDS.R1;
  const miss: string[] = [];
  if (m.rating === null || m.rating < t.rating) miss.push(`rating ≥ ${t.rating}`);
  if (m.rd === null || m.rd > t.rd) miss.push(`RD ≤ ${t.rd}`);
  if (m.matches < t.matches) miss.push(`≥ ${t.matches} missions`);
  if (m.eval_pass_rate === null || m.eval_pass_rate < t.eval_pass) miss.push(`eval pass ≥ ${t.eval_pass}`);
  if (m.security_incidents > 0) miss.push("0 security incidents");
  return miss;
}
function ruleR2(m: RankMetrics): string[] {
  const t = THRESHOLDS.R2;
  const miss: string[] = [];
  if (m.rating === null || m.rating < t.rating) miss.push(`rating ≥ ${t.rating}`);
  if (m.redteam_pass_rate === null || m.redteam_pass_rate < t.redteam_pass) miss.push(`red-team pass ≥ ${t.redteam_pass}`);
  if (m.court_score === null || m.court_score < t.court) miss.push(`Judge Court ≥ ${t.court}`);
  return miss;
}
function ruleR3(m: RankMetrics): string[] {
  const t = THRESHOLDS.R3;
  const miss: string[] = [];
  if (m.rating === null || m.rating < t.rating) miss.push(`rating ≥ ${t.rating}`);
  if (m.days_since_incident !== null && m.days_since_incident < t.clean_days) miss.push(`${t.clean_days} days without incident`);
  if (!m.owner_accepted) miss.push("owner acceptance");
  return miss;
}

/** Demotion triggers (§2.2): canary rollback, honeypot contact, 3 weak verdicts in 7 days, or a critical incident. */
export function demotionTriggers(m: RankMetrics): { steps: number; reasons: string[] } {
  const reasons: string[] = [];
  let steps = 0;
  if (m.critical_7d > 0) {
    reasons.push("critical incident");
    steps = 99; // straight to R0
  }
  if (m.honeypot_7d > 0) {
    reasons.push("honeypot contact");
    steps = Math.max(steps, 1);
  }
  if (m.canary_rollbacks_7d > 0) {
    reasons.push("canary rollback");
    steps = Math.max(steps, 1);
  }
  if (m.weak_verdicts_7d >= THRESHOLDS.weak_verdicts_limit) {
    reasons.push(`${m.weak_verdicts_7d} weak verdicts in ${THRESHOLDS.weak_verdicts_window_days} days`);
    steps = Math.max(steps, 1);
  }
  return { steps, reasons };
}

/**
 * Pure rank decision. Demotion wins over promotion. Promotion climbs one rank per review and only as far as the
 * metrics support; R3 needs owner acceptance; R4 is never reached automatically (an existing R4 holds unless demoted).
 */
export function evaluateRank(current: Rank, m: RankMetrics): RankDecision {
  const dem = demotionTriggers(m);
  if (dem.steps > 0 && rankNum(current) > 0) {
    const next = RANKS[Math.max(0, rankNum(current) - dem.steps)];
    return { current, eligible: next, next, change: "demote", reasons: dem.reasons, missing: [] };
  }
  const r1 = ruleR1(m);
  const r2 = r1.length ? ["R1 first"] : ruleR2(m);
  const r3 = r1.length || r2.length ? ["R2 first"] : ruleR3(m);
  let eligible: Rank = "R0";
  if (!r1.length) eligible = "R1";
  if (!r1.length && !r2.length) eligible = "R2";
  if (!r1.length && !r2.length && !r3.length) eligible = "R3";
  if (current === "R4" && dem.steps === 0) return { current, eligible: "R4", next: "R4", change: "hold", reasons: ["R4 is held by owner decision"], missing: [] };
  const missing = eligible === "R0" ? r1 : eligible === "R1" ? r2 : eligible === "R2" ? r3 : ["owner decision (R4)"];
  // Metrics fell below the current rank's bar (without an incident): hold — demotion is incident-driven only.
  if (rankNum(eligible) <= rankNum(current)) return { current, eligible, next: current, change: "hold", reasons: dem.reasons.length ? dem.reasons : [], missing };
  const next = RANKS[rankNum(current) + 1];
  return { current, eligible, next, change: "promote", reasons: [`meets ${next} criteria`], missing };
}

// ------------------------------------------------------------------ D1 side

export interface RankRow {
  agent_id: string;
  division: DivisionId;
  rank: Rank;
  court_score: number | null;
  owner_accepted: number;
  reason: string | null;
  updated_at: number;
}

export type IncidentKind = "security" | "canary_rollback" | "honeypot" | "weak_verdict" | "scope_violation" | "other";
export const INCIDENT_KINDS: IncidentKind[] = ["security", "canary_rollback", "honeypot", "weak_verdict", "scope_violation", "other"];

async function agentRole(env: Env, agentId: string): Promise<{ role: string; genome_id: string | null } | null> {
  return env.DB.prepare("SELECT role, genome_id FROM agents WHERE id = ?1").bind(agentId).first<{ role: string; genome_id: string | null }>();
}

/** Current rank row, created at R0 in the role's primary division on first sight. */
export async function getRankRow(env: Env, agentId: string, opts: { create?: boolean; division?: DivisionId } = {}): Promise<RankRow | null> {
  const r = await env.DB.prepare("SELECT * FROM army_ranks WHERE agent_id = ?1").bind(agentId).first<RankRow>();
  if (r || opts.create === false) return r;
  const a = await agentRole(env, agentId);
  const division = opts.division ?? (a ? divisionForRole(a.role) : "builders");
  await env.DB.prepare("INSERT OR IGNORE INTO army_ranks (agent_id, division, rank, owner_accepted, updated_at) VALUES (?1, ?2, 'R0', 0, ?3)").bind(agentId, division, Date.now()).run();
  return env.DB.prepare("SELECT * FROM army_ranks WHERE agent_id = ?1").bind(agentId).first<RankRow>();
}

export async function recordIncident(env: Env, agentId: string, kind: IncidentKind, severity: number, detail?: unknown, actor = "system"): Promise<string> {
  const id = `inc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const sev = Math.min(4, Math.max(1, Math.floor(severity)));
  await env.DB.prepare("INSERT INTO army_incidents (id, agent_id, kind, severity, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, agentId, kind, sev, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000), Date.now())
    .run();
  await armyAudit(env.DB, actor, "army.incident", agentId, { id, kind, severity: sev });
  return id;
}

/** Gather metrics from existing tables (read-only): elo_ratings, runs, evals, redteam_results, army_incidents. */
export async function gatherRankMetrics(env: Env, agentId: string, nowMs = Date.now()): Promise<RankMetrics> {
  const a = await agentRole(env, agentId);
  const row = await getRankRow(env, agentId, { create: false });
  let rating: number | null = null;
  let rd: number | null = null;
  let matches = 0;
  let evalPass: number | null = null;
  let redteam: number | null = null;
  if (a?.genome_id) {
    const elo = await env.DB.prepare("SELECT rating, rd, matches FROM elo_ratings WHERE genome_id = ?1").bind(a.genome_id).first<{ rating: number; rd: number; matches: number }>();
    if (elo) ({ rating, rd, matches } = elo);
    const ev = await env.DB.prepare("SELECT AVG(score) AS s, COUNT(*) AS n FROM evals WHERE genome_id = ?1 AND score IS NOT NULL AND created_at >= ?2")
      .bind(a.genome_id, nowMs - 30 * 86_400_000)
      .first<{ s: number | null; n: number }>();
    if (ev && ev.n > 0 && ev.s !== null) evalPass = ev.s;
    try {
      const rt = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN breach = 0 THEN 1 ELSE 0 END) AS ok FROM redteam_results WHERE genome_id = ?1")
        .bind(a.genome_id)
        .first<{ n: number; ok: number | null }>();
      if (rt && rt.n > 0) redteam = (rt.ok ?? 0) / rt.n;
    } catch {
      redteam = null; // red-team tables absent or shaped differently: treat as no evidence
    }
  }
  const missions = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?1 AND status = 'done'").bind(agentId).first<{ n: number }>();
  matches = Math.max(matches, missions?.n ?? 0);
  const week = nowMs - THRESHOLDS.weak_verdicts_window_days * 86_400_000;
  const inc = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN kind IN ('security','honeypot','scope_violation') THEN 1 ELSE 0 END) AS sec,
       MAX(at) AS last,
       SUM(CASE WHEN kind = 'canary_rollback' AND at >= ?2 THEN 1 ELSE 0 END) AS canary,
       SUM(CASE WHEN kind = 'honeypot' AND at >= ?2 THEN 1 ELSE 0 END) AS honey,
       SUM(CASE WHEN kind = 'weak_verdict' AND at >= ?2 THEN 1 ELSE 0 END) AS weak,
       SUM(CASE WHEN severity >= 4 AND at >= ?2 THEN 1 ELSE 0 END) AS crit
     FROM army_incidents WHERE agent_id = ?1`,
  )
    .bind(agentId, week)
    .first<{ sec: number | null; last: number | null; canary: number | null; honey: number | null; weak: number | null; crit: number | null }>();
  return {
    rating,
    rd,
    matches,
    eval_pass_rate: evalPass,
    redteam_pass_rate: redteam,
    court_score: row?.court_score ?? null,
    security_incidents: inc?.sec ?? 0,
    days_since_incident: inc?.last ? Math.floor((nowMs - inc.last) / 86_400_000) : null,
    canary_rollbacks_7d: inc?.canary ?? 0,
    honeypot_7d: inc?.honey ?? 0,
    weak_verdicts_7d: inc?.weak ?? 0,
    critical_7d: inc?.crit ?? 0,
    owner_accepted: !!row?.owner_accepted,
  };
}

export interface ReviewResult extends RankDecision {
  agent_id: string;
  division: DivisionId;
  metrics: RankMetrics;
  revoked?: { capabilities: number; passports: number };
}

/** Review one agent: apply promotion/demotion, revoke tokens on demotion, audit. */
export async function reviewRank(env: Env, agentId: string, actor = "system", metricsOverride?: Partial<RankMetrics>): Promise<ReviewResult> {
  const row = (await getRankRow(env, agentId))!;
  const metrics = { ...(await gatherRankMetrics(env, agentId)), ...(metricsOverride ?? {}) };
  const d = evaluateRank(row.rank, metrics);
  const out: ReviewResult = { ...d, agent_id: agentId, division: row.division, metrics };
  if (d.change === "hold") return out;
  await env.DB.prepare("UPDATE army_ranks SET rank = ?2, reason = ?3, updated_at = ?4 WHERE agent_id = ?1").bind(agentId, d.next, d.reasons.join("; ").slice(0, 500), Date.now()).run();
  if (d.change === "demote") {
    const ts = Date.now();
    const caps = await env.DB.prepare("UPDATE army_capabilities SET revoked_at = ?2, revoke_reason = 'demotion' WHERE agent_id = ?1 AND revoked_at IS NULL").bind(agentId, ts).run();
    const pps = await env.DB.prepare("UPDATE army_passports SET revoked_at = ?2, revoke_reason = 'demotion' WHERE agent_id = ?1 AND revoked_at IS NULL").bind(agentId, ts).run();
    out.revoked = { capabilities: caps.meta?.changes ?? 0, passports: pps.meta?.changes ?? 0 };
  }
  await armyAudit(env.DB, actor, `army.rank.${d.change}`, agentId, { from: d.current, to: d.next, reasons: d.reasons, revoked: out.revoked ?? null });
  return out;
}

/** Owner-only: set rank directly (R3 acceptance / R4 decision), division, court score. */
export async function ownerSetRank(env: Env, agentId: string, p: { rank?: Rank; division?: DivisionId; court_score?: number | null; owner_accepted?: boolean }, actor: string): Promise<RankRow> {
  if (actor !== "owner") throw new Error("only the owner can set ranks directly");
  const row = (await getRankRow(env, agentId, { division: p.division }))!;
  const next = {
    rank: p.rank && isRank(p.rank) ? p.rank : row.rank,
    division: p.division && isDivision(p.division) ? p.division : row.division,
    court_score: p.court_score === undefined ? row.court_score : p.court_score === null ? null : Math.min(1, Math.max(0, Number(p.court_score))),
    owner_accepted: p.owner_accepted === undefined ? row.owner_accepted : p.owner_accepted ? 1 : 0,
  };
  await env.DB.prepare("UPDATE army_ranks SET rank = ?2, division = ?3, court_score = ?4, owner_accepted = ?5, reason = 'owner', updated_at = ?6 WHERE agent_id = ?1")
    .bind(agentId, next.rank, next.division, next.court_score, next.owner_accepted, Date.now())
    .run();
  await armyAudit(env.DB, "owner", "army.rank.set", agentId, next);
  return (await getRankRow(env, agentId, { create: false }))!;
}
