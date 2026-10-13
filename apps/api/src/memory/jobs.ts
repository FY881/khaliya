/**
 * Job "memory.compact": org memory maintenance in small resumable steps (one unit of work per step, ≤ 1 LLM call
 * each, so the runner's 12-call / 20 s chunk cap always holds). Phases:
 *   review   critic-review pending org docs (≤ max_reviews per job)
 *   expire   TTL expiry / extension, 50 docs per step
 *   dedupe   near-duplicate sweep, 15 docs per step
 *   compact  summarise one 10-episode chunk of one crowded agent scope per step (≤ max_chunks per job)
 *   distill  fold new evolution notes into per-(role, operator) lesson notes, 100 notes per step
 * Kill switch / lab budget are enforced by the job runner + LabLLM (a budget stop ends the job early, cleanly).
 */
import { audit } from "../audit";
import type { JobHandler } from "../jobs/handlers";
import { compactChunk, dedupePass, expireDue, scopesNeedingCompaction } from "./compact";
import { distillLessons } from "./lessons";
import { criticReview } from "./review";
import type { MemoryEnv } from "./types";

export const MEMORY_PHASES = ["review", "expire", "dedupe", "compact", "distill", "done"] as const;
export type MemoryPhase = (typeof MEMORY_PHASES)[number];
export const MEMORY_COMPACT_KIND = "memory.compact";
export const MEMORY_COMPACT_CALLS = 40;

export interface MemoryCompactState {
  phase: MemoryPhase;
  phases: MemoryPhase[];
  max_reviews: number;
  max_chunks: number;
  skip: string[];
  reviewed: { approve: number; reject: number; untrusted: number; deferred: number };
  expired: number;
  extended: number;
  dedupe_cursor: number;
  merged: number;
  scopes: string[] | null;
  compacted: number;
  archived: number;
  lessons: number;
  notes_read: number;
}

export function memoryCompactInit(opts: { phases?: string[]; max_reviews?: number; max_chunks?: number } = {}): { state: MemoryCompactState; total: number } {
  const wanted = (opts.phases?.length ? MEMORY_PHASES.filter((p) => p !== "done" && opts.phases!.includes(p)) : MEMORY_PHASES.filter((p) => p !== "done")) as MemoryPhase[];
  const phases = [...wanted, "done"] as MemoryPhase[];
  return {
    state: {
      phase: phases[0],
      phases,
      max_reviews: Math.min(Math.max(0, Math.floor(opts.max_reviews ?? 20)), 100),
      max_chunks: Math.min(Math.max(0, Math.floor(opts.max_chunks ?? 10)), 50),
      skip: [],
      reviewed: { approve: 0, reject: 0, untrusted: 0, deferred: 0 },
      expired: 0,
      extended: 0,
      dedupe_cursor: 0,
      merged: 0,
      scopes: null,
      compacted: 0,
      archived: 0,
      lessons: 0,
      notes_read: 0,
    },
    total: phases.length,
  };
}

const advance = (s: MemoryCompactState) => {
  s.phase = s.phases[Math.min(s.phases.length - 1, s.phases.indexOf(s.phase) + 1)];
};

export const memoryCompactJob: JobHandler<MemoryCompactState> = {
  kind: MEMORY_COMPACT_KIND,
  async step(env, lab, _job, s) {
    const e = env as MemoryEnv;
    switch (s.phase) {
      case "review": {
        const n = s.reviewed.approve + s.reviewed.reject + s.reviewed.untrusted + s.reviewed.deferred;
        const skip = s.skip.length ? `AND id NOT IN (${s.skip.map((_, i) => `?${i + 1}`).join(",")})` : "";
        const next = n < s.max_reviews ? await e.DB.prepare(`SELECT id FROM kb_docs WHERE scope = 'org' AND trust = 'pending' AND status = 'active' ${skip} ORDER BY created_at LIMIT 1`).bind(...s.skip).first<{ id: string }>() : null;
        if (!next) {
          advance(s);
          return { message: `review: ${n} reviewed` };
        }
        const out = await criticReview(e, lab, next.id);
        s.reviewed[out.verdict]++;
        if (out.verdict === "deferred") s.skip = [...s.skip, next.id].slice(-90);
        return { message: `review ${next.id}: ${out.verdict} (${out.reviewer})` };
      }
      case "expire": {
        const r = await expireDue(e, 50);
        s.expired += r.expired;
        s.extended += r.extended;
        if (r.expired + r.extended < 50) advance(s);
        return { message: `expire: ${s.expired} expired, ${s.extended} extended` };
      }
      case "dedupe": {
        const r = await dedupePass(e, s.dedupe_cursor, 15);
        s.merged += r.merged;
        if (r.next === null) advance(s);
        else s.dedupe_cursor = r.next;
        return { message: `dedupe: ${s.merged} merged` };
      }
      case "compact": {
        if (s.scopes === null) s.scopes = await scopesNeedingCompaction(e, 20);
        if (!s.scopes.length || s.compacted >= s.max_chunks) {
          advance(s);
          return { message: `compact: ${s.compacted} chunks, ${s.archived} episodes archived` };
        }
        const scope = s.scopes[0];
        const r = await compactChunk(e, lab, scope);
        if (r) {
          s.compacted++;
          s.archived += r.archived;
        }
        // move on when the scope no longer qualifies
        const still = r ? (await scopesNeedingCompaction(e, 50)).includes(scope) : false;
        if (!still) s.scopes = s.scopes.slice(1);
        return { message: r ? `compact ${scope}: ${r.archived} → ${r.summary_id} (${r.method})` : `compact ${scope}: nothing to do` };
      }
      case "distill": {
        const r = await distillLessons(e, 100);
        s.notes_read += r.read;
        s.lessons += r.lessons.length;
        if (r.done) advance(s);
        return { message: `distill: ${s.notes_read} notes → ${s.lessons} lesson updates` };
      }
      default:
        s.phase = "done";
        return { message: "done" };
    }
  },
  isDone: (s) => s.phase === "done",
  progress: (s) => ({ done: s.phases.indexOf(s.phase), total: s.phases.length - 1 }),
  result: (s) => ({
    phase: s.phase,
    reviewed: s.reviewed,
    expired: s.expired,
    extended: s.extended,
    merged: s.merged,
    compacted: s.compacted,
    archived: s.archived,
    lessons: s.lessons,
    notes_read: s.notes_read,
  }),
  async onFinish(env, job, s, end) {
    await audit(env.DB, job.created_by ?? "owner", "memory.compact", job.id, { ...memoryCompactJob.result(s, job) as object, status: end.status, stopped: end.stopped ?? null, llm_calls: end.llm_calls });
  },
};

/** Cron helper: start one maintenance job per ~day (no-op when one ran in the last 20 h or one is active). */
export async function scheduleMemoryCompact(env: import("../env").Env): Promise<boolean> {
  const last = await env.DB.prepare("SELECT MAX(created_at) AS at FROM jobs WHERE kind = ?1").bind(MEMORY_COMPACT_KIND).first<{ at: number | null }>();
  if (last?.at && Date.now() - last.at < 20 * 3_600_000) return false;
  const { startJob } = await import("../jobs/routes");
  const init = memoryCompactInit();
  await startJob(env, { kind: MEMORY_COMPACT_KIND, params: { phases: init.state.phases, scheduled: true }, state: init.state, total: init.total, max_calls: MEMORY_COMPACT_CALLS, dedupe_key: MEMORY_COMPACT_KIND });
  return true;
}
