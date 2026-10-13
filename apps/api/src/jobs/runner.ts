/**
 * Job runner. One singleton Durable Object ("jobs") owns an alarm; each alarm invocation runs ONE chunk of the
 * oldest active job and re-arms itself while work remains. A chunk:
 *   - takes the job's lease (D1, so a cron kick or a test driver can never run the same chunk twice),
 *   - runs handler steps until ~CHUNK_SOFT_CALLS LLM calls or CHUNK_WALL_MS have been spent (heavy handlers:
 *     exactly one step), which keeps each invocation well inside the free plan's per-invocation subrequest and
 *     CPU limits,
 *   - saves the cursor, progress, partial result and spent calls, and releases the lease.
 * A step that throws restores the pre-step cursor (nothing half-done is skipped); 3 consecutive failing chunks
 * fail the job. Lab budget errors end the job early with `stopped` = budget | daily_budget | killed.
 * The half-hourly cron also kicks the runner, so a lost alarm only delays a job.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { LabBudgetError, LabLLM } from "../eval/llm";
import { Governor } from "../governor/governor";
import { LlmRouterError } from "../llm/router";
import { HANDLERS, type JobHandler } from "./handlers";
import { getJob, nextRunnable, nextWakeAt, takeLease, updateJob, type JobRow } from "./store";

export const CHUNK_SOFT_CALLS = 12;
export const CHUNK_WALL_MS = 20_000;
export const LEASE_MS = 10 * 60_000;
export const MAX_FAILURES = 3;
/** Consecutive chunks that may fail on provider errors before the job gives up (back-off 30 s → 4 min). */
export const MAX_TRANSIENT_FAILURES = 8;
/** Same share of the org's daily free LLM calls as every other lab request. */
const LAB_SHARE = 0.3;

const errMsg = (e: unknown) => {
  let m = String((e as Error)?.message ?? e);
  if (e instanceof LlmRouterError && e.attempts.length)
    m += " — " + e.attempts.slice(-6).map((a) => `${a.model.replace(/^workers-ai:@cf\//, "wai:")} ${a.status}${a.detail ? `: ${a.detail.slice(0, 90)}` : ""}`).join(" | ");
  return m.slice(0, 900);
};
/** Provider trouble (rate limits, capacity, outages) is transient: back off longer and allow more retries. */
const isTransient = (e: unknown) => e instanceof LlmRouterError;

export async function finishJob(env: Env, job: JobRow, h: JobHandler | undefined, state: unknown, end: { status: "done" | "failed" | "cancelled"; stopped?: string | null; error?: string | null; llm_calls: number }) {
  if (h?.onFinish) {
    try {
      await h.onFinish(env, job, state, end);
    } catch (e) {
      console.error("job onFinish failed", job.id, e);
    }
  }
}

export interface ChunkResult {
  ran: boolean;
  status?: string;
  steps?: number;
}

/** Run one chunk of `jobId` (no-op if another chunk holds the lease or the job is not active). */
export async function runChunk(env: Env, jobId: string): Promise<ChunkResult> {
  if (!(await takeLease(env, jobId, LEASE_MS))) return { ran: false };
  const job = (await getJob(env, jobId))!;
  const h = HANDLERS[job.kind];
  let state: any = job.state;
  const base = { chunks: job.chunks + 1, lease_until: null as number | null };
  if (!h || !state) {
    await updateJob(env, job.id, { ...base, status: "failed", error: h ? "job has no state" : `unknown job kind '${job.kind}'`, finished_at: Date.now() }, true);
    return { ran: true, status: "failed" };
  }
  const stopWith = async (stopped: string, steps: number, calls: number, message?: string): Promise<ChunkResult> => {
    const p = h.progress(state);
    const ok = await updateJob(
      env,
      job.id,
      { ...base, status: "done", stopped, state, result: h.result(state, job), llm_calls: calls, progress_done: p.done, progress_total: p.total, message: message ?? `stopped: ${stopped}`, finished_at: Date.now() },
      true,
    );
    await finishJob(env, job, h, state, { status: ok ? "done" : "cancelled", stopped: ok ? stopped : "cancelled", llm_calls: calls });
    return { ran: true, status: ok ? "done" : "cancelled", steps };
  };

  if ((await new Governor(env).isKilled()).killed) return stopWith("killed", 0, job.llm_calls, "global kill switch is ON");
  const remaining = job.max_calls - job.llm_calls;
  if (remaining <= 0 && !h.isDone(state)) return stopWith("budget", 0, job.llm_calls, `job budget of ${job.max_calls} LLM calls used`);

  const lab = new LabLLM(env, { maxCalls: Math.max(0, remaining), share: LAB_SHARE });
  const t0 = Date.now();
  let steps = 0;
  let message = job.message;
  let waitMs = 0;
  try {
    while (!h.isDone(state)) {
      if (steps > 0 && (h.heavy || lab.calls >= CHUNK_SOFT_CALLS || Date.now() - t0 > CHUNK_WALL_MS)) break;
      const snap = JSON.stringify(state);
      try {
        const out = await h.step(env, lab, job, state);
        message = out.message;
        steps++;
        if (out.waitMs) {
          waitMs = out.waitMs;
          break;
        }
      } catch (e) {
        state = JSON.parse(snap); // never skip half-done work
        throw e;
      }
    }
  } catch (e) {
    const calls = job.llm_calls + lab.calls;
    if (e instanceof LabBudgetError) return stopWith(e.scope === "killed" ? "killed" : e.scope === "daily" ? "daily_budget" : "budget", steps, calls, errMsg(e));
    const failures = job.failures + 1;
    const transient = isTransient(e);
    console.error("job chunk failed", job.id, job.kind, errMsg(e));
    if (failures >= (transient ? MAX_TRANSIENT_FAILURES : MAX_FAILURES)) {
      const p = h.progress(state);
      const ok = await updateJob(
        env,
        job.id,
        { ...base, status: "failed", failures, error: errMsg(e), state, result: h.result(state, job), llm_calls: calls, progress_done: p.done, progress_total: p.total, finished_at: Date.now() },
        true,
      );
      await finishJob(env, job, h, state, { status: ok ? "failed" : "cancelled", error: errMsg(e), llm_calls: calls });
      return { ran: true, status: "failed", steps };
    }
    const backoff = transient ? Math.min(240_000, 30_000 * 2 ** (failures - 1)) : 5_000 * failures;
    const ok = await updateJob(env, job.id, { ...base, failures, error: errMsg(e), state, llm_calls: calls, message, not_before: Date.now() + backoff }, true);
    if (!ok) await finishJob(env, job, h, state, { status: "cancelled", llm_calls: calls });
    return { ran: true, status: "running", steps };
  }

  const calls = job.llm_calls + lab.calls;
  const p = h.progress(state);
  const done = h.isDone(state);
  const ok = await updateJob(
    env,
    job.id,
    {
      ...base,
      status: done ? "done" : "running",
      state,
      result: h.result(state, job),
      llm_calls: calls,
      progress_done: p.done,
      progress_total: p.total,
      message,
      failures: 0,
      error: null,
      not_before: waitMs ? Date.now() + waitMs : null,
      finished_at: done ? Date.now() : null,
    },
    true,
  );
  if (!ok) {
    await finishJob(env, job, h, state, { status: "cancelled", stopped: "cancelled", llm_calls: calls });
    return { ran: true, status: "cancelled", steps };
  }
  if (done) await finishJob(env, job, h, state, { status: "done", llm_calls: calls });
  return { ran: true, status: done ? "done" : "running", steps };
}

/** Run one chunk of the next runnable job, if any. */
export async function runNext(env: Env): Promise<ChunkResult> {
  const job = await nextRunnable(env);
  if (!job) return { ran: false };
  return runChunk(env, job.id);
}

/**
 * Drive one job to a terminal state in-process (tests, local scripts). Waits out leases held by a concurrent
 * alarm and ignores back-off delays.
 */
export async function drainJob(env: Env, jobId: string, maxChunks = 500): Promise<JobRow> {
  for (let i = 0; i < maxChunks; i++) {
    const j = (await getJob(env, jobId))!;
    if (!["queued", "running"].includes(j.status)) return j;
    if (j.not_before && j.not_before > Date.now()) await updateJob(env, jobId, { not_before: null });
    const r = await runChunk(env, jobId);
    if (!r.ran) await new Promise((res) => setTimeout(res, 50));
  }
  return (await getJob(env, jobId))!;
}

/** Wake the runner (idempotent). Safe to call when the binding is missing. */
export async function kickJobs(env: Env): Promise<void> {
  try {
    if (!env.JOB_RUNNER) return;
    await env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName("jobs")).kick();
  } catch (e) {
    console.error("kickJobs failed", e);
  }
}

export class JobRunner extends DurableObject<Env> {
  async kick(): Promise<void> {
    const now = Date.now();
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > now + 1000) await this.ctx.storage.setAlarm(now + 100);
  }

  async alarm(): Promise<void> {
    try {
      await runNext(this.env);
    } finally {
      const wake = await nextWakeAt(this.env);
      if (wake !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 250, wake + 50));
    }
  }
}
