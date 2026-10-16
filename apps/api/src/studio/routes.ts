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
 *   POST /api/studio/reeval                 {brief_ids} → 202 job: re-run the current suite on each latest promoted genome;
 *                                           result.kept / result.flagged (flagged = below the promotion gate now)
 *   POST /api/studio/briefs/:id/validate-task {key, max_calls≤15} → Eval Factory validation of one task, not stored
 *   GET  /api/studio/designs                ?brief_id=&status=&limit= → {designs: [summary…]}
 *   GET  /api/studio/designs/:id            → {design: {…summary, report}} | 404
 *   POST /api/studio/services/:slug/invoke  {request, document?, runtime?: "hardened"|"legacy", version?} → one guarded
 *                                           service reply (1 lab call). Owner-only like everything here; services are
 *                                           not public (services_public=false on /api/health).
 */
import { Hono } from "hono";
import { audit } from "../audit";
import type { Env } from "../env";
import { jobAccepted, startJob } from "../jobs/routes";
import { briefProblems, taskRef } from "./briefs";
import { STUDIO_DESIGN_KIND, StudioJobError, studioDesignInit } from "./jobs";
import { getDesign, latestDesigns, listBriefRows, listDesigns, loadBrief, putOwnerBrief, StudioStoreError, type BriefRow } from "./store";
import { itemSpecOf } from "./briefs";
import { answerSnippet, ensureStudioSuite } from "./run";
import { LabLLM } from "../eval/llm";
import { LAB_SHARE } from "../eval/routes";
import { validateItem } from "../eval/validate";
import type { ResultInput } from "../eval/store";
import type { DesignRow, StoredBrief } from "./types";
import { invokeService, resolveService, ServiceError, SERVICE_RUNTIMES, type ServiceRuntime } from "./service";

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

async function startDesign(env: Env, briefIds: string[] | undefined, dedupe: string, mode?: "reeval") {
  const init = await studioDesignInit(env, briefIds, { mode });
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

/** Re-evaluate the latest promoted design of each brief on its current suite (flag, never silently keep). */
studioRoutes.post("/reeval", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { brief_ids?: unknown };
  const ids = Array.isArray(body.brief_ids) ? body.brief_ids.filter((x): x is string => typeof x === "string").slice(0, 12) : [];
  if (!ids.length) return c.json({ error: "brief_ids required" }, 400);
  try {
    return c.json(await startDesign(c.env, ids, `${STUDIO_DESIGN_KIND}:reeval:${[...ids].sort().join(",")}`, "reeval"), 202);
  } catch (e) {
    const r = jobError(e);
    return c.json(r.body, r.status);
  }
});

/**
 * Validate one brief task with the Eval Factory's full pipeline (structure, dedupe, solvable, anti-gaming,
 * discriminative = strong passes & weak fails, flake, critic) WITHOUT storing it. ≈5 lab calls for a code-checked task.
 * Returns the gate outcomes plus truncated strong/weak answers (owner-only diagnostics).
 */
studioRoutes.post("/briefs/:id/validate-task", async (c) => {
  const brief = await loadBrief(c.env, c.req.param("id"));
  if (!brief) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { key?: unknown; max_calls?: unknown };
  const t = brief.tasks.find((x) => x.key === body.key);
  if (!t) return c.json({ error: "task not found" }, 404);
  const maxCalls = Math.min(15, Math.max(1, Math.floor(Number(body.max_calls) || 8)));
  await ensureStudioSuite(c.env, brief);
  const lab = new LabLLM(c.env, { maxCalls, share: LAB_SHARE });
  const collect: ResultInput[] = [];
  try {
    const v = await validateItem(c.env, lab, itemSpecOf(brief, t), { persist: false, collect });
    await audit(c.env.DB, "owner", "studio.validate_task", taskRef(brief.id, t.key), { status: v.status, reason: v.reason ?? null, llm_calls: lab.calls });
    return c.json({
      brief_id: brief.id,
      key: t.key,
      status: v.status,
      reason: v.reason ?? null,
      quality: v.quality,
      gates: v.gates.map((g) => ({ gate: g.gate, pass: g.pass, reason: g.reason ?? null, data: g.gate === "discriminative" || g.gate === "critic" ? g.data : undefined })),
      answers: collect.map((r) => ({ ref: r.ref, pass: r.pass, answer: answerSnippet(r.answer).text })),
      llm_calls: lab.calls,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message, llm_calls: lab.calls }, 429);
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

studioRoutes.post("/services/:slug/invoke", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { request?: unknown; document?: unknown; runtime?: unknown; version?: unknown } | null;
  if (!body || typeof body !== "object") return c.json({ error: "JSON body required" }, 400);
  const runtime = (body.runtime ?? "hardened") as ServiceRuntime;
  if (!SERVICE_RUNTIMES.includes(runtime)) return c.json({ error: `runtime must be one of ${SERVICE_RUNTIMES.join(", ")}` }, 400);
  const version = body.version === undefined ? undefined : Math.floor(Number(body.version));
  if (version !== undefined && !(version >= 1)) return c.json({ error: "version must be a positive integer" }, 400);
  const target = await resolveService(c.env, c.req.param("slug"), version);
  if (!target) return c.json({ error: "service not found" }, 404);
  const lab = new LabLLM(c.env, { maxCalls: 1, share: LAB_SHARE });
  try {
    const reply = await invokeService(c.env, lab, target, { request: body.request as string, document: body.document as string | undefined }, { runtime });
    await audit(c.env.DB, "owner", "studio.service.invoke", `${target.slug}@${target.version}`, {
      runtime,
      guard: (reply.guard ?? reply.guard_preview)?.actions.map((a) => a.kind) ?? [],
      blocked: reply.guard?.blocked ?? false,
      input_flags: reply.input_flags.length,
    });
    return c.json({ reply });
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 400);
    throw e;
  }
});

export function mountStudioRoutes(app: { route: (path: string, r: Hono<any>) => unknown }): void {
  app.route("/api/studio", studioRoutes);
}
