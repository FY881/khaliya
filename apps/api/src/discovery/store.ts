/**
 * Discovery Lab persistence (D1, migration 0005) + certificate verification.
 *
 * Records: a new best becomes a 'candidate' with its exact solution, verifier hash, instance hash, program
 * and lineage. reverifyRecord() re-runs the verifier on the stored solution in a fresh sandbox with a seed
 * never used for it before; after 2 independent successful re-verifications the record becomes 'verified',
 * or 'beats_known_needs_review' when it is better than the published best (never claimed automatically).
 * A re-verification that disagrees with the stored score marks the record 'rejected'.
 */
import type { Env } from "../env";
import { runSandboxed } from "../forge/sandbox";
import { runVerifier, verifierHash } from "../forge/tool";
import { canonicalJson, newId, now, safeJsonParse, sha256Hex } from "../util";
import type { BestKnownStatus, Direction, ProblemDef, ProblemLimits, RecordStatus, VsKnown } from "./types";

export const REQUIRED_VERIFICATIONS = 2;

// ---------------- problems ----------------
export interface ProblemRow {
  id: string;
  family: string;
  title_en: string;
  title_ar: string;
  statement_en: string;
  statement_ar: string;
  direction: Direction;
  params: string;
  instance: string;
  verifier: string;
  verifier_hash: string;
  seed_program: string;
  best_known_score: number | null;
  best_known_status: BestKnownStatus;
  best_known_source: string;
  tolerance: number;
  limits: string | null;
  source: string;
  status: "active" | "paused" | "rejected";
  validation: string | null;
  examples: string | null;
  generation: number;
  islands: number;
  bandit: string | null;
  created_at: number;
  updated_at: number;
}

export const instanceHash = (instance: unknown) => sha256Hex(`instance\n${canonicalJson(instance)}`);

/** Insert a problem, or refresh its definition (verifier, texts, best-known) keeping its evolution state. */
export async function upsertProblem(env: Env, def: ProblemDef, extra: { status?: ProblemRow["status"]; validation?: unknown; islands?: number } = {}): Promise<ProblemRow> {
  const t = now();
  const vh = await verifierHash(def.verifier);
  await env.DB.prepare(
    `INSERT INTO discovery_problems (id, family, title_en, title_ar, statement_en, statement_ar, direction, params, instance, verifier, verifier_hash, seed_program,
       best_known_score, best_known_status, best_known_source, tolerance, limits, source, status, validation, examples, islands, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET family=excluded.family, title_en=excluded.title_en, title_ar=excluded.title_ar, statement_en=excluded.statement_en,
       statement_ar=excluded.statement_ar, direction=excluded.direction, params=excluded.params, instance=excluded.instance, verifier=excluded.verifier,
       verifier_hash=excluded.verifier_hash, seed_program=excluded.seed_program, best_known_score=excluded.best_known_score,
       best_known_status=excluded.best_known_status, best_known_source=excluded.best_known_source, tolerance=excluded.tolerance, limits=excluded.limits,
       validation=COALESCE(excluded.validation, discovery_problems.validation), examples=excluded.examples, updated_at=excluded.updated_at`,
  )
    .bind(
      def.id,
      def.family,
      def.title_en,
      def.title_ar,
      def.statement_en,
      def.statement_ar,
      def.direction,
      JSON.stringify(def.params ?? {}),
      JSON.stringify(def.instance),
      def.verifier,
      vh,
      def.seed_program,
      def.best_known.score,
      def.best_known.status,
      def.best_known.source,
      def.tolerance ?? 1e-9,
      def.limits ? JSON.stringify(def.limits) : null,
      def.source ?? "builtin",
      extra.status ?? "active",
      extra.validation === undefined ? null : JSON.stringify(extra.validation),
      JSON.stringify(def.examples ?? { good: [], bad: [] }),
      Math.max(1, Math.min(8, extra.islands ?? 3)),
      t,
      t,
    )
    .run();
  if (extra.status !== undefined) await env.DB.prepare(`UPDATE discovery_problems SET status = ? WHERE id = ?`).bind(extra.status, def.id).run();
  return (await getProblemRow(env, def.id))!;
}

export async function getProblemRow(env: Env, id: string): Promise<ProblemRow | null> {
  return env.DB.prepare(`SELECT * FROM discovery_problems WHERE id = ?`).bind(id).first<ProblemRow>();
}

export async function listProblemRows(env: Env, status?: ProblemRow["status"]): Promise<ProblemRow[]> {
  const q = status ? env.DB.prepare(`SELECT * FROM discovery_problems WHERE status = ? ORDER BY family, id`).bind(status) : env.DB.prepare(`SELECT * FROM discovery_problems ORDER BY family, id`);
  return (await q.all<ProblemRow>()).results ?? [];
}

/** Rebuild the in-memory definition of a stored problem (no host-side describe(); the engine falls back to 0). */
export function defFromRow(r: ProblemRow): ProblemDef {
  return {
    id: r.id,
    family: r.family,
    title_en: r.title_en,
    title_ar: r.title_ar,
    statement_en: r.statement_en,
    statement_ar: r.statement_ar,
    direction: r.direction,
    params: safeJsonParse<Record<string, unknown>>(r.params) ?? {},
    instance: safeJsonParse<Record<string, unknown>>(r.instance) ?? {},
    verifier: r.verifier,
    seed_program: r.seed_program,
    best_known: { score: r.best_known_score, status: r.best_known_status, source: r.best_known_source },
    examples: safeJsonParse<{ good: unknown[]; bad: unknown[] }>(r.examples) ?? { good: [], bad: [] },
    tolerance: r.tolerance,
    limits: safeJsonParse<ProblemLimits>(r.limits) ?? undefined,
    source: r.source,
  };
}

export async function saveEvolutionState(env: Env, problemId: string, generation: number, bandit: unknown): Promise<void> {
  await env.DB.prepare(`UPDATE discovery_problems SET generation = ?, bandit = ?, updated_at = ? WHERE id = ?`).bind(generation, JSON.stringify(bandit), now(), problemId).run();
}

// ---------------- programs ----------------
export interface ProgramRow {
  id: string;
  problem_id: string;
  island: number;
  hash: string;
  code: string;
  score: number | null;
  valid: number;
  cell: string | null;
  elite: number;
  parent_id: string | null;
  second_parent_id: string | null;
  operator: string;
  lineage: string | null;
  generation: number;
  eval_seed: number;
  solution: string | null;
  error: string | null;
  construct_ms: number | null;
  verify_ms: number | null;
  fuel_used: number | null;
  created_at: number;
}

export const programHash = (code: string) => sha256Hex(`program\n${code}`);

export type NewProgram = Omit<ProgramRow, "id" | "created_at" | "elite"> & { elite?: number };

export async function insertProgram(env: Env, p: NewProgram): Promise<ProgramRow> {
  const row: ProgramRow = { ...p, id: newId("dp"), elite: p.elite ?? 0, created_at: now() };
  await env.DB.prepare(
    `INSERT INTO discovery_programs (id, problem_id, island, hash, code, score, valid, cell, elite, parent_id, second_parent_id, operator, lineage, generation, eval_seed, solution, error, construct_ms, verify_ms, fuel_used, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(row.id, row.problem_id, row.island, row.hash, row.code, row.score, row.valid, row.cell, row.elite, row.parent_id, row.second_parent_id, row.operator, row.lineage, row.generation, row.eval_seed, row.solution, row.error, row.construct_ms, row.verify_ms, row.fuel_used, row.created_at)
    .run();
  return row;
}

export async function getProgram(env: Env, id: string): Promise<ProgramRow | null> {
  return env.DB.prepare(`SELECT * FROM discovery_programs WHERE id = ?`).bind(id).first<ProgramRow>();
}

export async function programExists(env: Env, problemId: string, island: number, hash: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS x FROM discovery_programs WHERE problem_id = ? AND island = ? AND hash = ?`).bind(problemId, island, hash).first());
}

export async function countPrograms(env: Env, problemId: string, island?: number): Promise<number> {
  const q =
    island === undefined
      ? env.DB.prepare(`SELECT COUNT(*) AS n FROM discovery_programs WHERE problem_id = ?`).bind(problemId)
      : env.DB.prepare(`SELECT COUNT(*) AS n FROM discovery_programs WHERE problem_id = ? AND island = ?`).bind(problemId, island);
  return (await q.first<{ n: number }>())?.n ?? 0;
}

/** Current MAP-Elites archive of one island (one row per occupied cell). */
export async function elitesOf(env: Env, problemId: string, island: number): Promise<ProgramRow[]> {
  return (await env.DB.prepare(`SELECT * FROM discovery_programs WHERE problem_id = ? AND island = ? AND elite = 1`).bind(problemId, island).all<ProgramRow>()).results ?? [];
}

export async function demoteElite(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE discovery_programs SET elite = 0 WHERE id = ?`).bind(id).run();
}

export async function topPrograms(env: Env, problemId: string, direction: Direction, limit = 3): Promise<ProgramRow[]> {
  const ord = direction === "max" ? "DESC" : "ASC";
  return (
    (await env.DB.prepare(`SELECT * FROM discovery_programs WHERE problem_id = ? AND valid = 1 ORDER BY score ${ord}, length(code) ASC LIMIT ?`).bind(problemId, limit).all<ProgramRow>()).results ?? []
  );
}

// ---------------- records ----------------
export interface RecordRow {
  id: string;
  problem_id: string;
  score: number;
  program_id: string | null;
  solution: string;
  verifier_hash: string;
  instance_hash: string;
  eval_seed: number;
  lineage: string | null;
  verified_count: number;
  verifications: string;
  reproducible: number | null;
  vs_known: VsKnown;
  best_known_score: number | null;
  status: RecordStatus;
  status_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface Verification {
  seed: number;
  valid: boolean;
  score: number;
  agrees: boolean;
  ms: number;
  detail?: string;
  at: number;
}

/** a strictly better than b (by more than tol). */
export function better(direction: Direction, a: number, b: number, tol = 1e-9): boolean {
  return direction === "max" ? a > b + tol : a < b - tol;
}

export function compareToKnown(direction: Direction, score: number, known: number | null, tol = 1e-9): VsKnown {
  if (known === null || known === undefined || !Number.isFinite(known)) return "unknown";
  if (better(direction, score, known, tol)) return "beats";
  if (Math.abs(score - known) <= tol) return "matches";
  return "below";
}

export async function bestRecord(env: Env, problemId: string, direction: Direction): Promise<RecordRow | null> {
  const ord = direction === "max" ? "DESC" : "ASC";
  return env.DB.prepare(`SELECT * FROM discovery_records WHERE problem_id = ? AND status != 'rejected' ORDER BY score ${ord}, created_at ASC LIMIT 1`).bind(problemId).first<RecordRow>();
}

export async function insertRecord(
  env: Env,
  problem: ProblemRow,
  r: { score: number; program_id: string | null; solution: unknown; verifier_hash: string; eval_seed: number; lineage: string | null },
): Promise<RecordRow> {
  const t = now();
  const row: RecordRow = {
    id: newId("dr"),
    problem_id: problem.id,
    score: r.score,
    program_id: r.program_id,
    solution: JSON.stringify(r.solution),
    verifier_hash: r.verifier_hash,
    instance_hash: await instanceHash(safeJsonParse(problem.instance)),
    eval_seed: r.eval_seed,
    lineage: r.lineage,
    verified_count: 0,
    verifications: "[]",
    reproducible: null,
    vs_known: compareToKnown(problem.direction, r.score, problem.best_known_score, problem.tolerance),
    best_known_score: problem.best_known_score,
    status: "candidate",
    status_reason: null,
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO discovery_records (id, problem_id, score, program_id, solution, verifier_hash, instance_hash, eval_seed, lineage, verified_count, verifications, reproducible, vs_known, best_known_score, status, status_reason, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(row.id, row.problem_id, row.score, row.program_id, row.solution, row.verifier_hash, row.instance_hash, row.eval_seed, row.lineage, 0, "[]", null, row.vs_known, row.best_known_score, row.status, null, t, t)
    .run();
  return row;
}

export async function getRecord(env: Env, id: string): Promise<RecordRow | null> {
  return env.DB.prepare(`SELECT * FROM discovery_records WHERE id = ?`).bind(id).first<RecordRow>();
}

export async function listRecords(env: Env, f: { problem_id?: string; status?: RecordStatus; limit?: number } = {}): Promise<RecordRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.problem_id) where.push("problem_id = ?"), args.push(f.problem_id);
  if (f.status) where.push("status = ?"), args.push(f.status);
  const sql = `SELECT * FROM discovery_records ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
  return (await env.DB.prepare(sql).bind(...args, Math.max(1, Math.min(200, f.limit ?? 50))).all<RecordRow>()).results ?? [];
}

/** Records still waiting for re-verification (oldest first). */
export async function pendingRecords(env: Env, limit = 5): Promise<RecordRow[]> {
  return (await env.DB.prepare(`SELECT * FROM discovery_records WHERE status = 'candidate' ORDER BY created_at ASC LIMIT ?`).bind(limit).all<RecordRow>()).results ?? [];
}

async function setRecord(env: Env, id: string, patch: Partial<Pick<RecordRow, "verified_count" | "verifications" | "status" | "status_reason" | "reproducible">>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE discovery_records SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => patch[k] as unknown), now(), id)
    .run();
}

export interface ReverifyOptions {
  /** Sandbox seed for this re-verification. Default: derived from the record and the attempt number. */
  seed?: number;
  /** Also re-run the program with its own seed and check it reproduces the certificate (first attempt only). */
  checkReproducible?: boolean;
  verifyFuel?: number;
  constructFuel?: number;
}

/**
 * One independent re-verification of a record's certificate (fresh QuickJS runtime, a seed different from
 * the evaluation seed and from every earlier re-verification). Bounded work: one verifier run, plus one
 * construct run on the first attempt when checkReproducible is set.
 */
export async function reverifyRecord(env: Env, recordId: string, o: ReverifyOptions = {}): Promise<RecordRow> {
  const rec = await getRecord(env, recordId);
  if (!rec) throw new Error(`unknown record ${recordId}`);
  if (rec.status !== "candidate") return rec;
  const problem = await getProblemRow(env, rec.problem_id);
  if (!problem) throw new Error(`unknown problem ${rec.problem_id}`);
  const history = safeJsonParse<Verification[]>(rec.verifications) ?? [];

  if (problem.verifier_hash !== rec.verifier_hash) {
    await setRecord(env, rec.id, { status: "rejected", status_reason: "the problem's verifier changed since this record was created; re-evaluate the program" });
    return (await getRecord(env, rec.id))!;
  }
  const instance = safeJsonParse(problem.instance);
  if ((await instanceHash(instance)) !== rec.instance_hash) {
    await setRecord(env, rec.id, { status: "rejected", status_reason: "the problem instance changed since this record was created" });
    return (await getRecord(env, rec.id))!;
  }

  const used = new Set<number>([rec.eval_seed, ...history.map((h) => h.seed)]);
  let seed = o.seed ?? ((rec.eval_seed * 2654435761 + 97 * (history.length + 1)) >>> 0) % 1_000_000_007;
  while (used.has(seed)) seed = (seed + 7919) >>> 0;

  const limits = safeJsonParse<ProblemLimits>(problem.limits) ?? {};
  const solution = safeJsonParse(rec.solution);
  const v = await runVerifier(problem.verifier, solution, { instance, seed, limits: { fuel: o.verifyFuel ?? limits.verifyFuel ?? 300 } });
  const agrees = v.valid && v.verifierHash === rec.verifier_hash && Math.abs(v.score - rec.score) <= Math.max(1e-12, problem.tolerance * 1e-3);
  const entry: Verification = { seed, valid: v.valid, score: v.score, agrees, ms: v.ms, detail: v.detail, at: now() };
  const verifications = JSON.stringify([...history, entry]);

  const patch: Parameters<typeof setRecord>[2] = { verifications };
  if (o.checkReproducible && rec.reproducible === null && rec.program_id) {
    const prog = await getProgram(env, rec.program_id);
    if (prog) {
      const r = await runSandboxed({ code: prog.code, entry: "construct", input: instance, limits: { fuel: o.constructFuel ?? limits.constructFuel ?? 400, seed: rec.eval_seed, maxOutputBytes: 256 * 1024, maxInputBytes: 256 * 1024 } });
      patch.reproducible = r.ok && canonicalJson(r.value) === canonicalJson(solution) ? 1 : 0;
    }
  }
  if (!agrees) {
    patch.status = "rejected";
    patch.status_reason = v.valid ? `re-verification score ${v.score} disagrees with the recorded ${rec.score}` : `re-verification failed: ${v.detail ?? "invalid"}`;
  } else {
    const count = rec.verified_count + 1;
    patch.verified_count = count;
    if (count >= REQUIRED_VERIFICATIONS) {
      if (rec.vs_known === "beats") {
        patch.status = "beats_known_needs_review";
        patch.status_reason = `score ${rec.score} beats the published ${rec.best_known_score} (${problem.best_known_status}; ${problem.best_known_source.slice(0, 300)}). Needs human review; never claimed automatically.`;
      } else {
        patch.status = "verified";
        patch.status_reason = `${count} independent re-verifications agree`;
      }
    }
  }
  await setRecord(env, rec.id, patch);
  return (await getRecord(env, rec.id))!;
}

/** Bounded maintenance step: up to `max` single re-verifications of pending records. */
export async function reverifyPending(env: Env, o: { max?: number; checkReproducible?: boolean } = {}): Promise<RecordRow[]> {
  const out: RecordRow[] = [];
  for (const r of await pendingRecords(env, Math.max(1, Math.min(10, o.max ?? 1)))) out.push(await reverifyRecord(env, r.id, { checkReproducible: o.checkReproducible }));
  return out;
}
