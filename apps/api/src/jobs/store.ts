/** D1 access for the `jobs` table (migration 0003). */
import type { Env } from "../env";
import { newId, safeJsonParse } from "../util";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["queued", "running"];

export interface JobRow {
  id: string;
  kind: string;
  status: JobStatus;
  params: Record<string, unknown>;
  state: unknown;
  dedupe_key: string | null;
  progress: { done: number; total: number; pct: number };
  message: string | null;
  result: unknown;
  error: string | null;
  stopped: string | null;
  llm_calls: number;
  max_calls: number;
  chunks: number;
  failures: number;
  lease_until: number | null;
  not_before: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

type Raw = Omit<JobRow, "params" | "state" | "result" | "progress"> & { params: string; state: string | null; result: string | null; progress_done: number; progress_total: number };

function toJob(r: Raw): JobRow {
  const { progress_done, progress_total, ...rest } = r;
  const total = Math.max(0, progress_total);
  const done = Math.max(0, Math.min(progress_done, total || progress_done));
  return {
    ...rest,
    params: safeJsonParse<Record<string, unknown>>(r.params) ?? {},
    state: safeJsonParse(r.state),
    result: safeJsonParse(r.result),
    progress: { done, total, pct: total ? Math.round((done / total) * 1000) / 10 : r.status === "done" ? 100 : 0 },
  };
}

export async function createJob(
  env: Env,
  j: { kind: string; params: Record<string, unknown>; state: unknown; total: number; max_calls: number; dedupe_key?: string | null; created_by?: string; id?: string },
): Promise<JobRow> {
  const now = Date.now();
  const id = j.id ?? newId("job");
  await env.DB.prepare(
    `INSERT INTO jobs (id, kind, status, params, state, dedupe_key, progress_total, max_calls, created_by, created_at, updated_at)
     VALUES (?1, ?2, 'queued', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  )
    .bind(id, j.kind, JSON.stringify(j.params), JSON.stringify(j.state ?? null), j.dedupe_key ?? null, Math.max(0, Math.floor(j.total)), j.max_calls, j.created_by ?? "owner", now)
    .run();
  return (await getJob(env, id))!;
}

export async function getJob(env: Env, id: string): Promise<JobRow | null> {
  const r = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Raw>();
  return r ? toJob(r) : null;
}

export async function activeJobByKey(env: Env, key: string): Promise<JobRow | null> {
  const r = await env.DB.prepare("SELECT * FROM jobs WHERE dedupe_key = ?1 AND status IN ('queued','running') ORDER BY created_at LIMIT 1").bind(key).first<Raw>();
  return r ? toJob(r) : null;
}

export async function listJobs(env: Env, opts: { status?: string; kind?: string; limit?: number } = {}): Promise<JobRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) where.push(`status = ?${args.push(opts.status)}`);
  if (opts.kind) where.push(`kind = ?${args.push(opts.kind)}`);
  const lim = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  const rows = (await env.DB.prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${lim}`).bind(...args).all<Raw>()).results;
  return rows.map(toJob);
}

/** The next job the runner should work on: running jobs first (FIFO), then queued ones. */
export async function nextRunnable(env: Env, now = Date.now()): Promise<JobRow | null> {
  const r = await env.DB.prepare(
    `SELECT * FROM jobs WHERE status IN ('queued','running') AND COALESCE(not_before, 0) <= ?1 AND COALESCE(lease_until, 0) < ?1
     ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at LIMIT 1`,
  )
    .bind(now)
    .first<Raw>();
  return r ? toJob(r) : null;
}

/** Earliest moment any active job can run again (null = no active job). */
export async function nextWakeAt(env: Env): Promise<number | null> {
  const r = await env.DB.prepare("SELECT MIN(MAX(COALESCE(not_before, 0), COALESCE(lease_until, 0))) AS t, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").first<{ t: number | null; n: number }>();
  return r && r.n > 0 ? (r.t ?? 0) : null;
}

/** Take the chunk lease; false if another chunk holds it or the job is no longer active. */
export async function takeLease(env: Env, id: string, ms: number, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE jobs SET lease_until = ?2, status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
       started_at = COALESCE(started_at, ?3), updated_at = ?3
     WHERE id = ?1 AND status IN ('queued','running') AND COALESCE(lease_until, 0) < ?3 RETURNING id`,
  )
    .bind(id, now + ms, now)
    .first<{ id: string }>();
  return r !== null;
}

export interface JobPatch {
  status?: JobStatus;
  state?: unknown;
  progress_done?: number;
  progress_total?: number;
  message?: string | null;
  result?: unknown;
  error?: string | null;
  stopped?: string | null;
  llm_calls?: number;
  chunks?: number;
  failures?: number;
  lease_until?: number | null;
  not_before?: number | null;
  finished_at?: number | null;
}

const JSON_COLS = new Set(["state", "result"]);
/** Patch a job. `onlyActive` = do nothing if it was cancelled/finished meanwhile; returns whether a row changed. */
export async function updateJob(env: Env, id: string, p: JobPatch, onlyActive = false): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [id];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    args.push(JSON_COLS.has(k) ? JSON.stringify(v) : v);
    sets.push(`${k} = ?${args.length}`);
  }
  args.push(Date.now());
  sets.push(`updated_at = ?${args.length}`);
  const r = await env.DB.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?1${onlyActive ? " AND status IN ('queued','running')" : ""}`).bind(...args).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Request cancellation: a queued job ends at once; a running one stops before its next step. */
export async function cancelJob(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', stopped = 'cancelled', finished_at = ?2, updated_at = ?2, lease_until = NULL WHERE id = ?1 AND status IN ('queued','running') RETURNING id",
  )
    .bind(id, Date.now())
    .first<{ id: string }>();
  return r !== null;
}

/** Shape for API responses: the resumable cursor stays server-side. */
export function publicJob(j: JobRow) {
  const { state: _s, lease_until: _l, ...rest } = j;
  return rest;
}
