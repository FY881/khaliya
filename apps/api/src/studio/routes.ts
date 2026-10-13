/**
 * Owner-only Agent Studio API. mountStudioRoutes(app) mounts it at /api/studio (behind index.ts's owner gate and
 * x-khaliya CSRF header, like every other /api/* route).
 *   GET  /api/studio/briefs                 seeds the 12 briefs lazily; {briefs: [{id, title, title_ar, purpose, purpose_ar,
 *                                           audience, role, safety_level, tasks, safety_tasks, source, service_slug,
 *                                           latest_design: {id, status, version, genome_id, updated_at} | null, spec}]}
 *   POST /api/studio/briefs                 owner brief (StoredBrief JSON) → 201 {brief} | 200 when replacing own brief;
 *                                           400 {error, problems[]} | 409 when the id is a seed brief
 *   POST /api/studio/briefs/:id/design      → 202 {job_id, reused, job, poll}  ("studio.design" job over that brief)
 *   POST /api/studio/design-all             → 202 {job_id, reused, job, poll}  (one job over every brief)
 *   GET  /api/studio/designs                ?brief_id=&status=&limit= → {designs: [summary…]}
 *   GET  /api/studio/designs/:id            → {design: {…summary, report}} | 404
 */
import { Hono } from "hono";
import { audit } from "../audit";
import type { Env } from "../env";
import { jobAccepted, startJob } from "../jobs/routes";
import { briefProblems, taskRef } from "./briefs";
import { STUDIO_DESIGN_KIND, StudioJobError, studioDesignInit } from "./jobs";
import { getDesign, latestDesigns, listBriefRows, listDesigns, putOwnerBrief, StudioStoreError, type BriefRow } from "./store";
import type { DesignRow, StoredBrief } from "./types";

type R = { Bindings: Env };
export const studioRoutes = new Hono<R>();

export function briefView(r: BriefRow, latest?: DesignRow) {
  const s = r.spec;
  return {
    id: r.id,
    title: r.title,
    title_ar: r.title_ar,
    purpose: s.purpose,
    purpose_ar: s.purpose_ar,
    audience: s.audience,
    role: s.role,
    safety_level: s.safety?.level,
    tasks: s.tasks.length,
    safety_tasks: s.tasks.filter((t) => t.kind === "safety").length,
    source: r.source,
    service_slug: s.service?.slug,
    latest_design: latest ? { id: latest.id, status: latest.status, version: latest.version, genome_id: latest.genome_id, updated_at: latest.updated_at } : null,
    spec: s,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function designView(d: DesignRow, withReport = false) {
  const rep = (d.report ?? {}) as Record<string, any>;
  return {
    id: d.id,
    brief_id: d.brief_id,
    version: d.version,
    status: d.status,
    genome_id: d.genome_id,
    lineage_id: d.lineage_id,
    suite_id: d.suite_id,
    job_id: d.job_id,
    decision: rep.decision ?? null,
    promoted: rep.promoted ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
    promoted_at: d.promoted_at,
    ...(withReport ? { report: d.report } : {}),
  };
}

studioRoutes.get("/briefs", async (c) => {
  const [rows, latest] = await Promise.all([listBriefRows(c.env), latestDesigns(c.env)]);
  return c.json({ briefs: rows.map((r) => briefView(r, latest.get(r.id))) });
});

studioRoutes.post("/briefs", async (c) => {
  const body = (await c.req.json().catch(() => null)) as StoredBrief | null;
  if (!body || typeof body !== "object") return c.json({ error: "JSON brief required" }, 400);
  // Owner task keys get the brief prefix in item inputs automatically (itemSpecOf); strip runtime-only fields.
  const spec: StoredBrief = {
    ...body,
    tasks: Array.isArray(body.tasks)
      ? body.tasks.map((t) => ({ key: t?.key, kind: t?.kind, task: t?.task, inputs: t?.inputs ?? {}, checker: t?.checker, reference: t?.reference, difficulty: t?.difficulty, tags: Array.isArray(t?.tags) ? t.tags : [] }))
      : (body.tasks as never),
  };
  const problems = briefProblems(spec);
  if (problems.length) return c.json({ error: "invalid brief", problems }, 400);
  try {
    const { row, created } = await putOwnerBrief(c.env, spec);
    await audit(c.env.DB, "owner", "studio.brief.put", row.id, { created, tasks: spec.tasks.map((t) => taskRef(row.id, t.key)) });
    return c.json({ brief: briefView(row) }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof StudioStoreError) return c.json({ error: e.message, code: e.code }, e.code === "conflict" ? 409 : 404);
    throw e;
  }
});

async function startDesign(env: Env, briefIds: string[] | undefined, dedupe: string) {
  const init = await studioDesignInit(env, briefIds);
  const { job, reused } = await startJob(env, { kind: STUDIO_DESIGN_KIND, params: init.params, state: init.state, total: init.total, max_calls: init.max_calls, dedupe_key: dedupe });
  return jobAccepted(job, reused);
}

function jobError(e: unknown) {
  if (e instanceof StudioJobError) return { body: { error: e.message, code: e.code }, status: (e.code === "not_found" ? 404 : 400) as 404 | 400 };
  throw e;
}

studioRoutes.post("/briefs/:id/design", async (c) => {
  const id = c.req.param("id");
  try {
    return c.json(await startDesign(c.env, [id], `${STUDIO_DESIGN_KIND}:${id}`), 202);
  } catch (e) {
    const r = jobError(e);
    return c.json(r.body, r.status);
  }
});

studioRoutes.post("/design-all", async (c) => {
  try {
    return c.json(await startDesign(c.env, undefined, `${STUDIO_DESIGN_KIND}:all`), 202);
  } catch (e) {
    const r = jobError(e);
    return c.json(r.body, r.status);
  }
});

studioRoutes.get("/designs", async (c) => {
  const designs = await listDesigns(c.env, { brief_id: c.req.query("brief_id") || undefined, status: c.req.query("status") || undefined, limit: Number(c.req.query("limit") ?? 50) || 50 });
  return c.json({ designs: designs.map((d) => designView(d)) });
});

studioRoutes.get("/designs/:id", async (c) => {
  const d = await getDesign(c.env, c.req.param("id"));
  if (!d) return c.json({ error: "not found" }, 404);
  return c.json({ design: designView(d, true) });
});

export function mountStudioRoutes(app: { route: (path: string, r: Hono<any>) => unknown }): void {
  app.route("/api/studio", studioRoutes);
}
