/**
 * Owner-only job API, mounted at /api/jobs by index.ts (behind the owner gate + x-khaliya CSRF header).
 *   GET  /api/jobs               newest first; ?status=&kind=&limit=
 *   GET  /api/jobs/:id           one job with progress, message, partial/final result
 *   POST /api/jobs/:id/cancel    queued → cancelled at once; running → stops before its next chunk
 * Jobs are created by the long-running lab endpoints (POST /api/evals/seed, /api/evals/suites/:id/saturation,
 * /api/evolution/generation, /api/evolution/tick), which answer 202 {job_id, job} immediately.
 */
import { Hono } from "hono";
import { audit } from "../audit";
import type { Env } from "../env";
import { HANDLERS } from "./handlers";
import { finishJob, kickJobs } from "./runner";
import { activeJobByKey, cancelJob, createJob, getJob, listJobs, publicJob, type JobRow } from "./store";

type R = { Bindings: Env };
export const jobRoutes = new Hono<R>();

jobRoutes.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 30) || 30;
  const jobs = await listJobs(c.env, { status: c.req.query("status") || undefined, kind: c.req.query("kind") || undefined, limit });
  return c.json({ jobs: jobs.map(publicJob) });
});

jobRoutes.get("/:id", async (c) => {
  const j = await getJob(c.env, c.req.param("id"));
  if (!j) return c.json({ error: "not found" }, 404);
  // A job that should be moving but whose alarm was lost gets a nudge whenever someone looks at it.
  if (j.status === "queued" || j.status === "running") await kickJobs(c.env);
  return c.json({ job: publicJob(j) });
});

jobRoutes.post("/:id/cancel", async (c) => {
  const j = await getJob(c.env, c.req.param("id"));
  if (!j) return c.json({ error: "not found" }, 404);
  const leased = (j.lease_until ?? 0) > Date.now();
  if (!(await cancelJob(c.env, j.id))) return c.json({ error: `job is already ${j.status}`, job: publicJob(j) }, 409);
  // No chunk is running → release what the job holds (e.g. the evolution lock) now; a running chunk does it itself.
  if (!leased) await finishJob(c.env, j, HANDLERS[j.kind], j.state, { status: "cancelled", stopped: "cancelled", llm_calls: j.llm_calls });
  await audit(c.env.DB, "owner", "job.cancel", j.id, { kind: j.kind });
  return c.json({ job: publicJob((await getJob(c.env, j.id))!) });
});

/** Create (or reuse an identical active) job, wake the runner, and answer 202. */
export async function startJob(
  env: Env,
  j: { kind: string; params: Record<string, unknown>; state: unknown; total: number; max_calls: number; dedupe_key?: string; id?: string },
): Promise<{ job: JobRow; reused: boolean }> {
  if (j.dedupe_key) {
    const ex = await activeJobByKey(env, j.dedupe_key);
    if (ex) {
      await kickJobs(env);
      return { job: ex, reused: true };
    }
  }
  const job = await createJob(env, j);
  await audit(env.DB, "owner", "job.create", job.id, { kind: j.kind, params: j.params, max_calls: j.max_calls });
  await kickJobs(env);
  return { job, reused: false };
}

export const jobAccepted = (job: JobRow, reused: boolean) => ({ job_id: job.id, reused, job: publicJob(job), poll: `/api/jobs/${job.id}` });
