/**
 * Owner-only Org Memory / KB API. `mountMemoryRoutes(app)` mounts it at /api/kb; it must be called AFTER the
 * owner-session gate in index.ts (like every other /api/* route).
 *   GET  /api/kb/docs                ?scope=org|agent:<id> &trust= &kind= &status=active &author= &limit= &offset=  → {docs, stats}
 *   POST /api/kb/docs                {title?, body, scope?, kind?, tags?, source?, trust?, ttl_days?, confidence?} → 201 {id, status, trust, flags, dup_of?}
 *   GET  /api/kb/docs/:id            → {doc, reviews}
 *   POST /api/kb/docs/:id/review     {verdict: approve|reject|untrusted, notes?} (owner) | {by: "critic"} (one critic LLM call) → {doc, outcome?}
 *   POST /api/kb/docs/:id/archive    {restore?: boolean} → {doc}
 *   GET  /api/kb/search?q=           &scope=org|agent:<id>|all &k= &trusted_only=1 → {query, mode, results, data}
 *   GET  /api/kb/lessons             ?role= &operator= → {lessons}
 *   POST /api/kb/reindex             {limit?≤25} → {enabled, embedded, failed, remaining} (backfill Vectorize)
 *   POST /api/kb/compact             {phases?, max_reviews?, max_chunks?, max_calls?} → 202 {job_id, job, poll}
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { labFor } from "../eval/routes";
import { LabBudgetError } from "../eval/llm";
import { jobAccepted, startJob } from "../jobs/routes";
import { neutralize, wrapRetrieved } from "./hygiene";
import { memoryCompactInit, MEMORY_COMPACT_CALLS, MEMORY_COMPACT_KIND } from "./jobs";
import { lessonsFor } from "./lessons";
import { criticReview } from "./review";
import { getDoc, kbStats, listDocs, reindexVectors, reviewDoc, reviewsFor, searchDocs, setStatus, writeDoc } from "./store";
import { KbError, type KbKind, type KbTrust, type MemoryEnv } from "./types";

type R = { Bindings: Env };
export const memoryRoutes = new Hono<R>();

const ERR_STATUS = { quota: 429, invalid: 400, forbidden: 403, not_found: 404, conflict: 409 } as const;
function fail(c: any, e: unknown) {
  if (e instanceof KbError) return c.json({ error: e.code, message: e.message }, ERR_STATUS[e.code]);
  if (e instanceof LabBudgetError) return c.json({ error: `lab_${e.scope}`, message: e.message }, e.scope === "killed" ? 423 : 429);
  throw e;
}
const env = (c: any) => c.env as MemoryEnv;

memoryRoutes.get("/docs", async (c) => {
  const q = c.req.query();
  const docs = await listDocs(env(c), { scope: q.scope || undefined, trust: q.trust || undefined, kind: q.kind || undefined, status: q.status || undefined, author: q.author || undefined, limit: Number(q.limit ?? 50) || 50, offset: Number(q.offset ?? 0) || 0 });
  return c.json({ docs, stats: await kbStats(env(c)) });
});

memoryRoutes.post("/docs", async (c) => {
  const b = await c.req.json<Record<string, any>>().catch(() => null);
  if (!b || typeof b.body !== "string") return c.json({ error: "invalid", message: "body (string) is required" }, 400);
  const trust = b.trust as KbTrust | undefined;
  if (trust && !["trusted", "pending", "untrusted"].includes(trust)) return c.json({ error: "invalid", message: "trust must be trusted | pending | untrusted" }, 400);
  try {
    const r = await writeDoc(env(c), {
      scope: typeof b.scope === "string" ? b.scope : "org",
      kind: b.kind as KbKind | undefined,
      title: typeof b.title === "string" ? b.title : undefined,
      body: b.body,
      tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
      source: typeof b.source === "string" ? b.source : "owner",
      author: "owner",
      author_role: "owner",
      trust,
      confidence: b.confidence === undefined ? undefined : Number(b.confidence),
      ttl_days: b.ttl_days === undefined ? undefined : b.ttl_days === null ? null : Number(b.ttl_days),
    });
    return c.json(r, r.status === "created" ? 201 : 200);
  } catch (e) {
    return fail(c, e);
  }
});

memoryRoutes.get("/docs/:id", async (c) => {
  const d = await getDoc(env(c), c.req.param("id"));
  if (!d) return c.json({ error: "not_found" }, 404);
  return c.json({ doc: d, reviews: await reviewsFor(env(c), d.id) });
});

memoryRoutes.post("/docs/:id/review", async (c) => {
  const b = ((await c.req.json<Record<string, any>>().catch(() => null)) ?? {}) as Record<string, any>;
  const id = c.req.param("id");
  try {
    if (b.by === "critic") {
      const outcome = await criticReview(env(c), labFor(c.env, 2), id);
      if (outcome.notes[0] === "not found") return c.json({ error: "not_found" }, 404);
      return c.json({ doc: await getDoc(env(c), id), outcome });
    }
    if (!["approve", "reject", "untrusted"].includes(b.verdict)) return c.json({ error: "invalid", message: 'verdict must be approve | reject | untrusted, or {by: "critic"}' }, 400);
    const doc = await reviewDoc(env(c), id, { verdict: b.verdict, reviewer: "owner", reviewer_role: "owner", method: "owner", notes: typeof b.notes === "string" ? b.notes : undefined });
    return c.json({ doc });
  } catch (e) {
    return fail(c, e);
  }
});

memoryRoutes.post("/docs/:id/archive", async (c) => {
  const b = ((await c.req.json<Record<string, any>>().catch(() => null)) ?? {}) as Record<string, any>;
  const d = await getDoc(env(c), c.req.param("id"));
  if (!d) return c.json({ error: "not_found" }, 404);
  await setStatus(env(c), [d.id], b.restore ? "active" : "archived");
  return c.json({ doc: await getDoc(env(c), d.id) });
});

memoryRoutes.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 300);
  if (!q.trim()) return c.json({ error: "invalid", message: "q is required" }, 400);
  const scopeQ = c.req.query("scope") || "org";
  let scopes: string[];
  if (scopeQ === "all") {
    const rows = (await c.env.DB.prepare("SELECT DISTINCT scope FROM kb_docs WHERE status = 'active' LIMIT 200").all<{ scope: string }>()).results;
    scopes = rows.length ? rows.map((r) => r.scope) : ["org"];
  } else scopes = scopeQ.split(",").map((s) => s.trim()).filter(Boolean);
  const { hits, mode } = await searchDocs(env(c), q, { scopes, k: Number(c.req.query("k") ?? 8) || 8, trustedOnly: ["1", "true"].includes(c.req.query("trusted_only") ?? ""), touch: false });
  return c.json({
    query: q,
    mode,
    results: hits.map((h) => ({ ...h, title: neutralize(h.title, 200), body: neutralize(h.body, 2000) })),
    data: wrapRetrieved(hits),
  });
});

memoryRoutes.get("/lessons", async (c) => {
  const role = c.req.query("role");
  if (role) return c.json({ lessons: await lessonsFor(c.env, role, c.req.query("operator") || undefined, 10) });
  return c.json({ lessons: (await listDocs(env(c), { scope: "org", kind: "lesson", limit: 100 })).map((d) => ({ id: d.id, title: d.title, body: d.body, updated_at: d.updated_at })) });
});

memoryRoutes.post("/reindex", async (c) => {
  const b = ((await c.req.json<Record<string, any>>().catch(() => null)) ?? {}) as Record<string, any>;
  return c.json(await reindexVectors(env(c), Number(b.limit ?? 10)));
});

memoryRoutes.post("/compact", async (c) => {
  const b = ((await c.req.json<Record<string, any>>().catch(() => null)) ?? {}) as Record<string, any>;
  const init = memoryCompactInit({ phases: Array.isArray(b.phases) ? b.phases.map(String) : undefined, max_reviews: b.max_reviews, max_chunks: b.max_chunks });
  const max_calls = Math.min(Math.max(1, Math.floor(Number(b.max_calls ?? MEMORY_COMPACT_CALLS))), 200);
  const { job, reused } = await startJob(c.env, { kind: MEMORY_COMPACT_KIND, params: { phases: init.state.phases, max_reviews: init.state.max_reviews, max_chunks: init.state.max_chunks }, state: init.state, total: init.total, max_calls, dedupe_key: MEMORY_COMPACT_KIND });
  return c.json(jobAccepted(job, reused), 202);
});

/** Mount at /api/kb (call after the owner gate in index.ts). */
export function mountMemoryRoutes(app: Hono<any>): void {
  app.route("/api/kb", memoryRoutes);
}
