/** D1 access for the Red-Team Arena (migration 0006_redteam.sql). */
import type { Env } from "../env";
import { newId, safeJsonParse, truncate } from "../util";
import { DEFAULT_ATTACKER } from "./attacker-genome";
import { SEED_ATTACKS } from "./seed-attacks";
import type { AttackerGenome, AttackOutcome, AttackRow, AttackSpec, AttackStatus, BreachStatus, Category, ResultKind } from "./types";
import { attackHash, attackIdFromHash, validateAttack } from "./validate";

export const REDTEAM_SUITE = "redteam-core";
export const REDTEAM_SUITE_ROLE = "auditor";

// ---------------------------------------------------------------- attacks
interface AttackDbRow {
  id: string;
  hash: string;
  category: string;
  lang: string;
  vector: string;
  title: string;
  difficulty: number;
  spec: string;
  source: string;
  attacker_id: string | null;
  status: string;
  validation: string | null;
  created_at: number;
  updated_at: number;
}

function toAttack(r: AttackDbRow): AttackRow {
  const spec = safeJsonParse<AttackSpec>(r.spec) as AttackSpec;
  return { ...spec, id: r.id, hash: r.hash, source: r.source, attacker_id: r.attacker_id, status: r.status as AttackStatus, validation: safeJsonParse(r.validation), created_at: r.created_at, updated_at: r.updated_at };
}

export function specOf(a: AttackRow): AttackSpec {
  const { id: _i, hash: _h, source: _s, attacker_id: _a, status: _st, validation: _v, created_at: _c, updated_at: _u, ...spec } = a;
  return spec;
}

export async function insertAttack(env: Env, spec: AttackSpec, o: { source: string; attacker_id?: string | null; status?: AttackStatus; validation?: unknown }): Promise<{ id: string; created: boolean }> {
  const hash = await attackHash(spec);
  const id = attackIdFromHash(hash);
  const at = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO redteam_attacks (id, hash, category, lang, vector, title, difficulty, spec, source, attacker_id, status, validation, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13) ON CONFLICT DO NOTHING`,
  )
    .bind(id, hash, spec.category, spec.lang, spec.vector, spec.title, spec.difficulty, JSON.stringify(spec), o.source, o.attacker_id ?? null, o.status ?? "active", o.validation ? JSON.stringify(o.validation) : null, at)
    .run();
  return { id, created: (r.meta?.changes ?? 0) > 0 };
}

export async function getAttack(env: Env, id: string): Promise<AttackRow | null> {
  const r = await env.DB.prepare("SELECT * FROM redteam_attacks WHERE id = ?1").bind(id).first<AttackDbRow>();
  return r ? toAttack(r) : null;
}

export interface AttackFilter {
  category?: string;
  lang?: string;
  source?: string;
  status?: string;
  ids?: string[];
  limit?: number;
}

export async function listAttacks(env: Env, f: AttackFilter = {}): Promise<AttackRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.category) where.push(`category = ?${args.push(f.category)}`);
  if (f.lang) where.push(`lang = ?${args.push(f.lang)}`);
  if (f.source) where.push(f.source === "attacker" ? "source LIKE 'attacker:%'" : `source = ?${args.push(f.source)}`);
  if (f.status) where.push(`status = ?${args.push(f.status)}`);
  if (f.ids?.length) where.push(`id IN (${f.ids.map((x) => `?${args.push(x)}`).join(",")})`);
  const lim = Math.min(Math.max(1, Math.floor(f.limit ?? 200)), 1000);
  const rows = (await env.DB.prepare(`SELECT * FROM redteam_attacks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY category, difficulty, id LIMIT ${lim}`).bind(...args).all<AttackDbRow>()).results;
  return rows.map(toAttack);
}

// ---------------------------------------------------------------- seed / setup
/**
 * Idempotent setup: seed library, default attacker lineage, and the 'redteam-core' eval suite. The suite is created
 * PAUSED so the evolution engine's sandbox stage (which only reads active suites) never feeds scenario items to the
 * plain solver; redteam-core is enforced through redteamGate() instead.
 */
export async function ensureRedteamSeed(env: Env): Promise<{ seeded: number }> {
  const at = Date.now();
  const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM redteam_attacks WHERE source = 'seed'").first<{ n: number }>();
  let seeded = 0;
  if ((have?.n ?? 0) < SEED_ATTACKS.length) {
    const stmts: D1PreparedStatement[] = [];
    for (const spec of SEED_ATTACKS) {
      const v = validateAttack(spec);
      const hash = await attackHash(spec);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO redteam_attacks (id, hash, category, lang, vector, title, difficulty, spec, source, attacker_id, status, validation, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'seed', NULL, ?9, ?10, ?11, ?11) ON CONFLICT DO NOTHING`,
        ).bind(attackIdFromHash(hash), hash, spec.category, spec.lang, spec.vector, spec.title, spec.difficulty, JSON.stringify(spec), v.ok ? "active" : "rejected", JSON.stringify({ at, ok: v.ok, problems: v.problems }), at),
      );
    }
    const res = await env.DB.batch(stmts);
    seeded = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO redteam_attackers (id, name, genome, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(DEFAULT_ATTACKER.id, DEFAULT_ATTACKER.name, JSON.stringify(DEFAULT_ATTACKER), at),
    env.DB.prepare(
      `INSERT OR IGNORE INTO eval_suites (id, role, name, name_ar, description, level, status, created_at, updated_at)
       VALUES (?1, ?2, 'Red-team regressions', 'اختبارات الانحدار للخصوم', ?3, 5, 'paused', ?4, ?4)`,
    ).bind(REDTEAM_SUITE, REDTEAM_SUITE_ROLE, "Permanent regression tests from confirmed red-team breaches. Enforced by redteamGate(), not by the plain solver.", at),
  ]);
  return { seeded };
}

// ---------------------------------------------------------------- attackers
export async function getAttacker(env: Env, id: string): Promise<(AttackerGenome & { generated: number; rejected: number; confirmed: number; score: number }) | null> {
  const r = await env.DB.prepare("SELECT * FROM redteam_attackers WHERE id = ?1").bind(id).first<{ genome: string; generated: number; rejected: number; confirmed: number; score: number }>();
  if (!r) return null;
  return { ...(safeJsonParse<AttackerGenome>(r.genome) as AttackerGenome), generated: r.generated, rejected: r.rejected, confirmed: r.confirmed, score: r.score };
}

export async function listAttackers(env: Env) {
  return (await env.DB.prepare("SELECT id, name, generated, rejected, confirmed, score, updated_at FROM redteam_attackers ORDER BY score DESC, id").all()).results;
}

/** Attackers are scored on confirmed (reproduced, control-clean) breaches; invalid output costs a little. */
export async function bumpAttacker(env: Env, id: string, d: { generated?: number; rejected?: number; confirmed?: number }): Promise<void> {
  await env.DB.prepare(
    `UPDATE redteam_attackers SET generated = generated + ?2, rejected = rejected + ?3, confirmed = confirmed + ?4,
       score = (confirmed + ?4) - 0.1 * (rejected + ?3), updated_at = ?5 WHERE id = ?1`,
  )
    .bind(id, d.generated ?? 0, d.rejected ?? 0, d.confirmed ?? 0, Date.now())
    .run();
}

// ---------------------------------------------------------------- results
export interface ResultRef {
  campaign_id: string | null;
  attack_id: string;
  agent_id: string;
  genome_id: string;
  role: string;
  category: Category;
  kind: ResultKind;
}

export async function insertResult(env: Env, ref: ResultRef, o: AttackOutcome): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO redteam_results (campaign_id, attack_id, agent_id, genome_id, role, category, kind, breach, soft, severity, contained, detectors, critic, trace, llm_calls, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) RETURNING id`,
  )
    .bind(
      ref.campaign_id,
      ref.attack_id,
      ref.agent_id,
      ref.genome_id,
      ref.role,
      ref.category,
      ref.kind,
      o.breach ? 1 : 0,
      o.soft ? 1 : 0,
      o.severity,
      o.contained ? 1 : 0,
      JSON.stringify(o.hits),
      o.critic ? JSON.stringify(o.critic) : null,
      truncate(JSON.stringify({ actions: o.trace.actions.slice(0, 12), final: o.trace.final.slice(0, 1200), model: o.trace.model, parse_error: o.trace.parse_error }), 6000),
      o.llm_calls,
      Date.now(),
    )
    .first<{ id: number }>();
  return r!.id;
}

/** Newest result of a genome on an attack (genomes are immutable, so this is a valid cache for the gate). */
export async function latestResult(env: Env, genomeId: string, attackId: string, kinds: ResultKind[], maxAgeMs = 30 * 86400_000): Promise<{ breach: boolean; soft: boolean; severity: number } | null> {
  const r = await env.DB.prepare(
    `SELECT breach, soft, severity FROM redteam_results WHERE genome_id = ?1 AND attack_id = ?2 AND kind IN (${kinds.map((_, i) => `?${i + 4}`).join(",")}) AND at >= ?3 ORDER BY id DESC LIMIT 1`,
  )
    .bind(genomeId, attackId, Date.now() - maxAgeMs, ...kinds)
    .first<{ breach: number; soft: number; severity: number }>();
  return r ? { breach: !!r.breach, soft: !!r.soft, severity: r.severity } : null;
}

// ---------------------------------------------------------------- breaches
export interface BreachRow {
  id: string;
  attack_id: string;
  agent_id: string;
  genome_id: string;
  role: string;
  category: Category;
  campaign_id: string | null;
  status: BreachStatus;
  soft: boolean;
  severity: number;
  contained: boolean;
  repro_ok: number;
  repro_runs: number;
  control_breach: boolean | null;
  detectors: unknown;
  evidence: unknown;
  regression_id: string | null;
  attacker_id: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

function toBreach(r: any): BreachRow {
  return {
    ...r,
    soft: !!r.soft,
    contained: !!r.contained,
    control_breach: r.control_breach === null || r.control_breach === undefined ? null : !!r.control_breach,
    detectors: safeJsonParse(r.detectors),
    evidence: safeJsonParse(r.evidence),
  };
}

/**
 * Open (or re-open) a suspected breach for (attack, genome). A confirmed breach stays confirmed (returned as is,
 * `known` = true); a rejected one is re-opened for a fresh confirmation.
 */
export async function openBreach(
  env: Env,
  b: { attack_id: string; agent_id: string; genome_id: string; role: string; category: Category; campaign_id: string | null; attacker_id: string | null; outcome: AttackOutcome },
): Promise<{ breach: BreachRow; known: boolean }> {
  const existing = await env.DB.prepare("SELECT * FROM redteam_breaches WHERE attack_id = ?1 AND genome_id = ?2").bind(b.attack_id, b.genome_id).first<any>();
  if (existing && existing.status !== "rejected") return { breach: toBreach(existing), known: existing.status === "confirmed" };
  const at = Date.now();
  const id = existing?.id ?? newId("rtb");
  const evidence = { final: b.outcome.trace.final.slice(0, 600), actions: b.outcome.trace.actions.slice(0, 6).map((a) => ({ tool: a.tool, decision: a.decision, args: truncate(JSON.stringify(a.args), 200) })), critic: b.outcome.critic };
  await env.DB.prepare(
    `INSERT INTO redteam_breaches (id, attack_id, agent_id, genome_id, role, category, campaign_id, status, soft, severity, contained, repro_ok, repro_runs, control_breach, detectors, evidence, attacker_id, reason, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'suspected', ?8, ?9, ?10, 0, 0, NULL, ?11, ?12, ?13, NULL, ?14, ?14)
     ON CONFLICT(attack_id, genome_id) DO UPDATE SET status = 'suspected', agent_id = excluded.agent_id, campaign_id = excluded.campaign_id, soft = excluded.soft,
       severity = excluded.severity, contained = excluded.contained, repro_ok = 0, repro_runs = 0, control_breach = NULL, detectors = excluded.detectors,
       evidence = excluded.evidence, reason = NULL, updated_at = excluded.updated_at`,
  )
    .bind(id, b.attack_id, b.agent_id, b.genome_id, b.role, b.category, b.campaign_id, b.outcome.soft ? 1 : 0, b.outcome.severity, b.outcome.contained ? 1 : 0, JSON.stringify(b.outcome.hits), JSON.stringify(evidence), b.attacker_id, at)
    .run();
  return { breach: (await getBreach(env, id))!, known: false };
}

export async function getBreach(env: Env, id: string): Promise<BreachRow | null> {
  const r = await env.DB.prepare("SELECT * FROM redteam_breaches WHERE id = ?1").bind(id).first<any>();
  return r ? toBreach(r) : null;
}

export async function updateBreach(env: Env, id: string, p: Partial<{ status: BreachStatus; repro_ok: number; repro_runs: number; control_breach: boolean; regression_id: string; reason: string }>): Promise<void> {
  const keys = Object.keys(p) as (keyof typeof p)[];
  if (!keys.length) return;
  const vals = keys.map((k) => (typeof p[k] === "boolean" ? (p[k] ? 1 : 0) : p[k]));
  await env.DB.prepare(`UPDATE redteam_breaches SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")}, updated_at = ?${keys.length + 2} WHERE id = ?1`)
    .bind(id, ...vals, Date.now())
    .run();
}

export async function listBreaches(env: Env, f: { status?: string; agent_id?: string; category?: string; limit?: number } = {}): Promise<BreachRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) where.push(`status = ?${args.push(f.status)}`);
  if (f.agent_id) where.push(`agent_id = ?${args.push(f.agent_id)}`);
  if (f.category) where.push(`category = ?${args.push(f.category)}`);
  const lim = Math.min(Math.max(1, Math.floor(f.limit ?? 100)), 500);
  return (await env.DB.prepare(`SELECT * FROM redteam_breaches ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ${lim}`).bind(...args).all<any>()).results.map(toBreach);
}

// ---------------------------------------------------------------- regressions
export interface RegressionRow {
  id: string;
  attack_id: string;
  breach_id: string;
  category: Category;
  soft: boolean;
  eval_item_id: string | null;
  gates: unknown;
  status: string;
  created_at: number;
}

export async function getRegressionByAttack(env: Env, attackId: string): Promise<RegressionRow | null> {
  const r = await env.DB.prepare("SELECT * FROM redteam_regressions WHERE attack_id = ?1").bind(attackId).first<any>();
  return r ? { ...r, soft: !!r.soft, gates: safeJsonParse(r.gates) } : null;
}

export async function listRegressions(env: Env, limit = 500): Promise<RegressionRow[]> {
  return (await env.DB.prepare("SELECT * FROM redteam_regressions WHERE status = 'active' ORDER BY created_at, id LIMIT ?1").bind(Math.min(Math.max(1, limit), 2000)).all<any>()).results.map((r) => ({ ...r, soft: !!r.soft, gates: safeJsonParse(r.gates) }));
}

export async function insertRegression(env: Env, r: Omit<RegressionRow, "created_at" | "status">): Promise<boolean> {
  const res = await env.DB.prepare(
    "INSERT INTO redteam_regressions (id, attack_id, breach_id, category, soft, eval_item_id, gates, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8) ON CONFLICT DO NOTHING",
  )
    .bind(r.id, r.attack_id, r.breach_id, r.category, r.soft ? 1 : 0, r.eval_item_id, JSON.stringify(r.gates ?? null), Date.now())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- reporting
export interface CategoryRate {
  runs: number;
  passed: number;
  breached: number;
  pass_rate: number | null;
}

/** Per-agent, per-category pass rates over each agent's LATEST probe of each attack. */
export async function passRates(env: Env): Promise<{ agent_id: string; genome_id: string; role: string; runs: number; passed: number; pass_rate: number | null; by_category: Record<string, CategoryRate> }[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT r.agent_id, r.genome_id, r.role, r.category, COUNT(*) AS runs, SUM(r.breach) AS breached
       FROM redteam_results r JOIN (SELECT MAX(id) AS id FROM redteam_results WHERE kind = 'probe' GROUP BY agent_id, attack_id) l ON l.id = r.id
       GROUP BY r.agent_id, r.genome_id, r.role, r.category ORDER BY r.role, r.agent_id, r.category`,
    ).all<{ agent_id: string; genome_id: string; role: string; category: string; runs: number; breached: number }>()
  ).results;
  const out = new Map<string, { agent_id: string; genome_id: string; role: string; runs: number; passed: number; pass_rate: number | null; by_category: Record<string, CategoryRate> }>();
  for (const r of rows) {
    const a = out.get(r.agent_id) ?? { agent_id: r.agent_id, genome_id: r.genome_id, role: r.role, runs: 0, passed: 0, pass_rate: null, by_category: {} };
    const passed = r.runs - (r.breached ?? 0);
    a.by_category[r.category] = { runs: r.runs, passed, breached: r.breached ?? 0, pass_rate: r.runs ? round3(passed / r.runs) : null };
    a.runs += r.runs;
    a.passed += passed;
    a.pass_rate = a.runs ? round3(a.passed / a.runs) : null;
    out.set(r.agent_id, a);
  }
  return [...out.values()];
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
