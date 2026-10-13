/**
 * Discovery Lab ↔ job runner.
 *   "discovery.evolve"   N generations of one problem, ONE generation per chunk using DISCOVERY_FREE_PLAN
 *                        (1 child, tiny fuel) with llm "auto" through the job's LabLLM budgets; then every record
 *                        the run produced is re-verified (one verification per chunk) so it can become 'verified'.
 *   "discovery.reverify" all candidate records (oldest first), one independent re-verification per chunk.
 * A record that beats the published best ends as 'beats_known_needs_review' and is never announced as a record:
 * its audit/event is a review flag (announce = false).
 */
import { audit } from "../audit";
import type { Env } from "../env";
import type { LabLLM } from "../eval/llm";
import type { JobHandler } from "../jobs/handlers";
import { DISCOVERY_FREE_PLAN, stepGeneration, type StepOptions } from "./evolve";
import { getRecord, pendingRecords, REQUIRED_VERIFICATIONS, reverifyRecord, type RecordRow } from "./store";

export const MAX_EVOLVE_GENERATIONS = 200;
export const MAX_REVERIFY_RECORDS = 50;
/** Re-verification attempts per record inside one job (2 needed; 1 spare for a lease retry). */
const ATTEMPTS_PER_RECORD = REQUIRED_VERIFICATIONS + 1;

export interface PlanOptions {
  children: number;
  constructFuel: number;
  verifyFuel: number;
}

/** Owner overrides are clamped; default is the free-plan profile. */
export function planFrom(o: { children?: unknown; construct_fuel?: unknown; verify_fuel?: unknown } = {}): PlanOptions {
  const n = (v: unknown, d: number, max: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x >= 1 ? Math.min(x, max) : d;
  };
  return { children: n(o.children, DISCOVERY_FREE_PLAN.children, 8), constructFuel: n(o.construct_fuel, DISCOVERY_FREE_PLAN.constructFuel, 2000), verifyFuel: n(o.verify_fuel, DISCOVERY_FREE_PLAN.verifyFuel, 2000) };
}

/** Audit (→ hive event) for a record status change after a re-verification. */
async function auditRecordOutcome(env: Env, before: RecordRow, after: RecordRow): Promise<void> {
  if (before.status === after.status) return;
  const detail = { problem: after.problem_id, score: after.score, vs_known: after.vs_known, best_known: after.best_known_score, verified_count: after.verified_count, reason: after.status_reason?.slice(0, 300) ?? null };
  const action =
    after.status === "verified" ? "discovery.record_verified" : after.status === "beats_known_needs_review" ? "discovery.record_needs_review" : after.status === "rejected" ? "discovery.record_rejected" : null;
  if (action) await audit(env.DB, "system:discovery", action, after.id, detail);
}

/** One re-verification of `id` (with a reproducibility check on its first attempt). Returns the new row. */
async function reverifyOnce(env: Env, id: string): Promise<{ before: RecordRow | null; after: RecordRow | null }> {
  const before = await getRecord(env, id);
  if (!before || before.status !== "candidate") return { before, after: before };
  const after = await reverifyRecord(env, id, { checkReproducible: true });
  await auditRecordOutcome(env, before, after);
  return { before, after };
}

// ---------------------------------------------------------------- discovery.evolve
export interface GenSummary {
  gen: number;
  island: number;
  best: number | null;
  evaluated: number;
  improved: number;
  llm: number;
  record?: string;
}

export interface EvolveJobState {
  problem_id: string;
  generations: number;
  done: number;
  plan: PlanOptions;
  llm: "auto" | "off";
  llm_off_reason: string | null;
  phase: "evolve" | "reverify" | "done";
  history: GenSummary[];
  records: string[];
  verify_i: number;
  verify_attempts: number;
  evaluated: number;
  llm_calls: number;
  best: number | null;
  start_best: number | null;
}

const HISTORY_KEEP = 200;

export const discoveryEvolveJob: JobHandler<EvolveJobState> = {
  kind: "discovery.evolve",
  heavy: true, // one generation (or one re-verification) per chunk
  async step(env, lab: LabLLM, job, s) {
    if (s.phase === "evolve") {
      const opts: StepOptions = { children: s.plan.children, constructFuel: s.plan.constructFuel, verifyFuel: s.plan.verifyFuel, llm: s.llm, seed: `${job.id}:${s.done}` };
      const r = await stepGeneration(env, s.llm === "off" ? null : lab, s.problem_id, opts);
      s.done++;
      s.evaluated += r.evaluated;
      s.llm_calls += r.llmCalls;
      if (s.start_best === null && s.done === 1) s.start_best = r.best;
      s.best = r.best;
      // a budget/kill stop of the LLM is sticky for the rest of the job; a transient provider error is not
      if (r.llmDisabledReason && /^(daily|killed|tick):/.test(r.llmDisabledReason)) {
        s.llm = "off";
        s.llm_off_reason = r.llmDisabledReason;
      }
      s.history.push({ gen: r.generation, island: r.island, best: r.best, evaluated: r.evaluated, improved: r.children.filter((c) => c.improved).length, llm: r.llmCalls, record: r.newRecord?.id });
      if (s.history.length > HISTORY_KEEP) s.history.splice(0, s.history.length - HISTORY_KEEP);
      if (r.newRecord) {
        s.records.push(r.newRecord.id);
        await audit(env.DB, "system:discovery", "discovery.record", r.newRecord.id, { problem: s.problem_id, score: r.newRecord.score, vs_known: r.newRecord.vs_known, generation: r.generation, status: "candidate" });
      }
      if (s.done >= s.generations) s.phase = s.records.length ? "reverify" : "done";
      return { message: `${s.problem_id}: generation ${s.done}/${s.generations} · best ${r.best ?? "—"}${r.newRecord ? ` · new record ${r.newRecord.score} (${r.newRecord.vs_known})` : ""}` };
    }
    if (s.phase === "reverify") {
      // only the newest record matters for the board, but every one gets its certificate checked
      const id = s.records[s.verify_i];
      const { after } = await reverifyOnce(env, id);
      s.verify_attempts++;
      if (!after || after.status !== "candidate" || s.verify_attempts >= ATTEMPTS_PER_RECORD) {
        s.verify_i++;
        s.verify_attempts = 0;
      }
      if (s.verify_i >= s.records.length) s.phase = "done";
      return { message: `${s.problem_id}: re-verified ${id} → ${after?.status ?? "missing"} (${after?.verified_count ?? 0}/${REQUIRED_VERIFICATIONS})` };
    }
    return { message: "done" };
  },
  isDone: (s) => s.phase === "done",
  progress: (s) => ({ done: s.done + (s.phase === "done" ? s.records.length : s.verify_i), total: s.generations + s.records.length }),
  result: (s) => ({
    problem_id: s.problem_id,
    generations: s.generations,
    generations_done: s.done,
    best: s.best,
    start_best: s.start_best,
    evaluated: s.evaluated,
    llm_calls: s.llm_calls,
    llm: s.llm,
    llm_off_reason: s.llm_off_reason,
    records: s.records,
    phase: s.phase,
    history: s.history.slice(-50),
  }),
  async onFinish(env, _job, s, end) {
    await audit(env.DB, "owner", "discovery.evolve", s.problem_id, { generations: s.done, best: s.best, records: s.records.length, evaluated: s.evaluated, llm_calls: end.llm_calls, status: end.status, stopped: end.stopped ?? null });
  },
};

export function evolveJobInit(problemId: string, generations: number, plan: PlanOptions, llm: "auto" | "off" = "auto"): { state: EvolveJobState; total: number } {
  const g = Math.max(1, Math.min(MAX_EVOLVE_GENERATIONS, Math.floor(generations)));
  return {
    state: { problem_id: problemId, generations: g, done: 0, plan, llm, llm_off_reason: null, phase: "evolve", history: [], records: [], verify_i: 0, verify_attempts: 0, evaluated: 0, llm_calls: 0, best: null, start_best: null },
    total: g,
  };
}

// ---------------------------------------------------------------- discovery.reverify
export interface ReverifyJobState {
  queue: string[];
  i: number;
  attempts: number;
  outcomes: Record<string, string>;
}

export const discoveryReverifyJob: JobHandler<ReverifyJobState> = {
  kind: "discovery.reverify",
  heavy: true, // one verifier run (+ one reproducibility run) per chunk
  async step(env, _lab, _job, s) {
    const id = s.queue[s.i];
    const { after } = await reverifyOnce(env, id);
    s.attempts++;
    if (!after || after.status !== "candidate" || s.attempts >= ATTEMPTS_PER_RECORD) {
      s.outcomes[id] = after?.status ?? "missing";
      s.i++;
      s.attempts = 0;
    }
    return { message: `re-verified ${id} → ${after?.status ?? "missing"} (${s.i}/${s.queue.length})` };
  },
  isDone: (s) => s.i >= s.queue.length,
  progress: (s) => ({ done: s.i, total: s.queue.length }),
  result: (s) => {
    const counts: Record<string, number> = {};
    for (const v of Object.values(s.outcomes)) counts[v] = (counts[v] ?? 0) + 1;
    return { records: s.queue.length, checked: s.i, outcomes: s.outcomes, counts };
  },
  async onFinish(env, _job, s, end) {
    await audit(env.DB, "owner", "discovery.reverify", null, { records: s.queue.length, checked: s.i, status: end.status, stopped: end.stopped ?? null });
  },
};

export async function reverifyJobInit(env: Env, max = MAX_REVERIFY_RECORDS): Promise<{ state: ReverifyJobState; total: number }> {
  const queue = (await pendingRecords(env, Math.max(1, Math.min(MAX_REVERIFY_RECORDS, max)))).map((r) => r.id);
  return { state: { queue, i: 0, attempts: 0, outcomes: {} }, total: queue.length };
}
