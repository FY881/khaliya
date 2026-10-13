/**
 * Job kinds. Each handler advances a serializable cursor by ONE unit of work per `step` call; the runner
 * (runner.ts) decides how many steps fit in one chunk. Everything a handler needs between chunks lives in
 * its state, so a chunk can die at any point and the next one resumes from the last saved state.
 */
import { audit } from "../audit";
import type { Role } from "../constitution";
import type { Env } from "../env";
import { STARTER_SUITES } from "../eval/families";
import { saturationDone, saturationInit, saturationStep, saturationTotal, type SaturationCursor } from "../eval/ladder";
import type { LabLLM } from "../eval/llm";
import { newSeedCursor, seedProgress, seedStep, seedSummaryOf, seedTotal, type SeedCursor } from "../eval/seed";
import { generationInit, generationStep, GENERATION_PHASES, tick, type GenerationCursor, type GenerationResult, type TickSummary } from "../evolution/engine";
import type { OperatorId } from "../evolution/operators";
import { acquireLock, releaseLock, renewLock } from "../evolution/store";
import type { SolverGenome } from "../eval/solver";
import type { JobRow } from "./store";
import { forgeAdmitJob } from "../forge/jobs";
import { discoveryEvolveJob, discoveryReverifyJob } from "../discovery/jobs";
import { redteamCampaignJob } from "../redteam/jobs";
import { P5_JOB_HANDLERS } from "../court/handlers";
import { STUDIO_JOB_HANDLERS } from "../studio/jobs";
// ARMY_JOB_HANDLERS (army.mission) is NOT imported here: army/swarm.ts -> jobs/routes.ts -> this file is a cycle.
// It is registered after declaration via Object.assign in src/index.ts (and idempotently by registerArmyJobs()).

export interface StepOut {
  message: string;
  /** Ask the runner to pause this job (no failure) and retry after this many ms. */
  waitMs?: number;
}

export interface JobHandler<S = any> {
  kind: string;
  /** true = at most one step per chunk (a step may make many LLM calls). */
  heavy?: boolean;
  step(env: Env, lab: LabLLM, job: JobRow, state: S): Promise<StepOut>;
  isDone(state: S): boolean;
  progress(state: S): { done: number; total: number };
  result(state: S, job: JobRow): unknown;
  /** Called once when the job ends (done / failed / cancelled / stopped): release locks, audit. Must not throw. */
  onFinish?(env: Env, job: JobRow, state: S, end: { status: string; stopped?: string | null; error?: string | null; llm_calls: number }): Promise<void>;
}

export const EVOLUTION_LOCK_TTL = 15 * 60_000;
export const jobLockHolder = (jobId: string) => `job:${jobId}`;

// ---------------------------------------------------------------- eval.seed
export interface SeedJobState {
  cursor: SeedCursor;
}
export const seedJob: JobHandler<SeedJobState> = {
  kind: "eval.seed",
  async step(env, lab, _job, s) {
    const r = await seedStep(env, lab, s.cursor);
    return { message: r.message };
  },
  isDone: (s) => s.cursor.done,
  progress: (s) => ({ done: seedProgress(s.cursor), total: seedTotal(s.cursor) }),
  result: (s) => seedSummaryOf(s.cursor),
  async onFinish(env, _job, s, end) {
    const sum = seedSummaryOf(s.cursor);
    await audit(env.DB, "owner", "eval.seed", null, { suites: s.cursor.suites, created: sum.created, active: sum.active, llm_calls: end.llm_calls, status: end.status, stopped: end.stopped ?? null });
  },
};
export function seedJobInit(suites: string[] | undefined): { state: SeedJobState; total: number } {
  const defs = suites?.length ? STARTER_SUITES.filter((d) => suites.includes(d.id)) : STARTER_SUITES;
  const cursor = newSeedCursor(defs);
  return { state: { cursor }, total: seedTotal(cursor) };
}

// ---------------------------------------------------------------- eval.saturation
export interface SaturationJobState {
  cursor: SaturationCursor;
}
export const saturationJob: JobHandler<SaturationJobState> = {
  kind: "eval.saturation",
  async step(env, lab, _job, s) {
    const c = s.cursor;
    const phase = c.phase;
    await saturationStep(env, lab, c);
    if (phase === "solve" && c.result === null) return { message: `${c.suite_id}: solved ${c.i}/${c.item_ids.length} (${c.passed} passed)` };
    if (phase === "solve") return { message: `${c.suite_id}: pass rate ${c.result!.pass_rate}${c.result!.saturated ? " — saturated" : ""}` };
    return { message: `${c.suite_id}: ladder candidate ${c.ladder?.n ?? 0} (active ${c.ladder?.out.active.length ?? 0})` };
  },
  isDone: (s) => s.cursor.phase === "done",
  progress: (s) => ({ done: saturationDone(s.cursor) + (s.cursor.phase === "done" ? 1 : 0), total: saturationTotal(s.cursor) + 1 }),
  result: (s) => s.cursor.result ?? { suite_id: s.cursor.suite_id, n: s.cursor.item_ids.length, solved: s.cursor.i, passed: s.cursor.passed },
  async onFinish(env, _job, s, end) {
    const r = s.cursor.result;
    await audit(env.DB, "owner", "eval.saturation", s.cursor.suite_id, { pass_rate: r?.pass_rate ?? null, n: r?.n ?? s.cursor.item_ids.length, saturated: r?.saturated ?? null, laddered: !!r?.ladder, llm_calls: end.llm_calls, status: end.status, stopped: end.stopped ?? null });
  },
};
export async function saturationJobInit(env: Env, suiteId: string, opts: { ladder?: boolean; count?: number; genome?: SolverGenome }) {
  const cursor = await saturationInit(env, suiteId, opts);
  return { state: { cursor } as SaturationJobState, total: saturationTotal(cursor) + 1 };
}

// ---------------------------------------------------------------- evolution.generation
export interface GenerationJobState {
  cursor: GenerationCursor;
  holder: string;
}
export const generationJob: JobHandler<GenerationJobState> = {
  kind: "evolution.generation",
  heavy: true, // one stage per chunk
  async step(env, lab, _job, s) {
    if (!(await renewLock(env, s.holder, EVOLUTION_LOCK_TTL))) throw new Error("evolution lock lost (expired and taken by another holder)");
    const from = s.cursor.phase;
    await generationStep(env, lab, s.cursor);
    const r = s.cursor.result;
    return { message: r ? `${s.cursor.input.role}: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}` : `${s.cursor.input.role}: ${from} → ${s.cursor.phase}` };
  },
  isDone: (s) => s.cursor.phase === "done",
  progress: (s) => ({ done: s.cursor.phase === "done" ? GENERATION_PHASES.length : GENERATION_PHASES.indexOf(s.cursor.phase as (typeof GENERATION_PHASES)[number]), total: GENERATION_PHASES.length }),
  result: (s) => s.cursor.result ?? { role: s.cursor.input.role, proposal_id: s.cursor.pid, stage: s.cursor.phase },
  async onFinish(env, _job, s, end) {
    await releaseLock(env, s.holder);
    const g = s.cursor.result as GenerationResult | null;
    await audit(env.DB, "owner", "evolution.generation", g?.proposal_id ?? s.cursor.pid, { role: s.cursor.input.role, operator: g?.operator ?? s.cursor.input.operator ?? null, outcome: g?.outcome ?? end.status, llm_calls: end.llm_calls, job: true });
  },
};
/** Takes the evolution lock for the job (false = busy). */
export async function generationJobInit(env: Env, jobId: string, role: Role, operator?: OperatorId): Promise<{ state: GenerationJobState; total: number } | null> {
  const holder = jobLockHolder(jobId);
  if (!(await acquireLock(env, holder, EVOLUTION_LOCK_TTL))) return null;
  return { state: { cursor: generationInit({ role, seed: `owner:${Date.now()}`, operator }), holder }, total: GENERATION_PHASES.length };
}

// ---------------------------------------------------------------- evolution.tick
export interface TickJobState {
  roles?: Role[];
  max: number;
  i: number;
  phase: "canaries" | "gens" | "done";
  waits: number;
  summary: Pick<TickSummary, "generations" | "canaries" | "stopped"> & { status: string };
}
const MAX_LOCK_WAITS = 40; // × 15 s = 10 min
export const tickJob: JobHandler<TickJobState> = {
  kind: "evolution.tick",
  heavy: true, // one canary sweep or one generation per chunk
  async step(env, lab, job, s) {
    const holder = `${jobLockHolder(job.id)}:${s.phase}:${s.i}`;
    const t =
      s.phase === "canaries"
        ? await tick(env, lab, { maxProposals: 0, roles: s.roles, holder })
        : await tick(env, lab, { maxProposals: 1, advanceCanaries: false, roles: s.roles, holder, seed: `${job.id}|${s.i}` });
    if (t.status === "locked") {
      if (++s.waits > MAX_LOCK_WAITS) throw new Error("evolution lock stayed busy for 10 minutes");
      return { message: "waiting for the evolution lock", waitMs: 15_000 };
    }
    s.waits = 0;
    if (t.status === "killed") {
      s.summary.status = "killed";
      s.summary.stopped = "killed";
      s.phase = "done";
      return { message: "global kill switch is ON" };
    }
    if (s.phase === "canaries") {
      s.summary.canaries.push(...t.canaries);
      if (t.stopped && t.stopped !== "no_roles") s.summary.stopped = t.stopped;
      s.phase = s.max > 0 && !s.summary.stopped ? "gens" : "done";
      return { message: `canaries advanced: ${t.canaries.length}` };
    }
    s.summary.generations.push(...t.generations);
    s.i++;
    if (t.stopped) s.summary.stopped = t.stopped;
    if (t.stopped || s.i >= s.max) s.phase = "done";
    const g = t.generations.at(-1);
    return { message: g ? `generation ${s.i}/${s.max}: ${g.role} ${g.operator} → ${g.outcome}` : `generation ${s.i}/${s.max}: ${t.stopped ?? "nothing to do"}` };
  },
  isDone: (s) => s.phase === "done",
  progress: (s) => ({ done: (s.phase === "canaries" ? 0 : 1) + s.i + (s.phase === "done" ? s.max - s.i : 0), total: 1 + s.max }),
  result: (s) => s.summary,
  async onFinish(env, _job, s, end) {
    await audit(env.DB, "owner", "evolution.tick.manual", null, { roles: s.roles ?? null, max_proposals: s.max, generations: s.summary.generations.length, stopped: s.summary.stopped ?? end.stopped ?? null, job: true });
  },
};
export function tickJobInit(roles: Role[] | undefined, max: number): { state: TickJobState; total: number } {
  return { state: { roles, max, i: 0, phase: "canaries", waits: 0, summary: { status: "ok", generations: [], canaries: [] } }, total: 1 + max };
}

export const HANDLERS: Record<string, JobHandler> = {
  [seedJob.kind]: seedJob,
  [saturationJob.kind]: saturationJob,
  [generationJob.kind]: generationJob,
  [tickJob.kind]: tickJob,
  [forgeAdmitJob.kind]: forgeAdmitJob,
  [discoveryEvolveJob.kind]: discoveryEvolveJob,
  [discoveryReverifyJob.kind]: discoveryReverifyJob,
  [redteamCampaignJob.kind]: redteamCampaignJob,
  ...P5_JOB_HANDLERS,
  ...STUDIO_JOB_HANDLERS,
};
