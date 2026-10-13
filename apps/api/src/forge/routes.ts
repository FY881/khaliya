/**
 * Owner-only Tool Forge API, mounted at /api/forge by index.ts (owner session + x-khaliya CSRF header on writes).
 *   GET  /api/forge/tools                 newest version per name (+counts); ?status=admitted|pending|rejected|deprecated
 *   GET  /api/forge/tools/:name           code, spec, tests summary, gate results, usage, versions, admission job; ?version=
 *   POST /api/forge/submit                spec → 202 {job_id, job, poll, tool} ("forge.admit" job) | 200 duplicate | 422
 *   POST /api/forge/tools/:name/run       {input, version?} → sandboxed test run (plan fuel cap)
 *   POST /api/forge/tools/:name/retire    {reason?} → every admitted version becomes deprecated
 */
import { Hono } from "hono";
import { audit } from "../audit";
import type { Env } from "../env";
import { Governor } from "../governor/governor";
import { jobAccepted, startJob } from "../jobs/routes";
import { activeJobByKey, getJob, publicJob } from "../jobs/store";
import { effectiveLimits } from "./admission";
import { forgeAdmitInit, forgeAdmitKey, FORGE_ADMIT_CALLS, precheckSpec, stagePending } from "./jobs";
import { runSandboxed } from "./sandbox";
import { forgeCounts, getToolByName, listLatestTools, retireToolName, runsFor, specOf, successRate, toolVersions, type ForgeToolRow } from "./store";
import { executeForgeTool, FORGE_TIER, forgeFuelCap } from "./tool";
import type { ForgeStatus, ForgeTest, ForgeToolSpec } from "./types";

type R = { Bindings: Env };
export const forgeRoutes = new Hono<R>();

const STATUSES: ForgeStatus[] = ["pending", "admitted", "rejected", "deprecated"];

function gateSummary(t: ForgeToolRow) {
  return (t.report?.gates ?? []).map((g) => ({ gate: g.gate, pass: g.pass, skipped: !!g.skipped }));
}

export function toolSummary(t: ForgeToolRow & { versions?: number; admitted_version?: number | null }) {
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    status: t.status,
    status_reason: t.status_reason,
    description: t.spec.description,
    author: t.author,
    lineage_id: t.lineage_id,
    tier: FORGE_TIER,
    tests: Array.isArray(t.spec.tests) ? t.spec.tests.length : 0,
    code_bytes: t.code.length,
    gates: gateSummary(t),
    warnings: t.report?.warnings?.length ?? 0,
    uses: t.uses,
    successes: t.successes,
    failures: t.failures,
    success_rate: successRate(t),
    last_used_at: t.last_used_at,
    admitted_at: t.admitted_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
    versions: t.versions ?? 1,
    admitted_version: t.admitted_version ?? (t.status === "admitted" ? t.version : null),
  };
}

function testsSummary(tests: ForgeTest[] | undefined) {
  const list = Array.isArray(tests) ? tests : [];
  return {
    total: list.length,
    with_expect: list.filter((t) => t && "expect" in t && t.expect !== undefined).length,
    with_checker: list.filter((t) => t && !!t.checker).length,
    items: list.map((t, i) => ({ i, name: t?.name ?? null, input: t?.input, expect: t?.expect, checker: t?.checker ?? null })),
  };
}

forgeRoutes.get("/tools", async (c) => {
  const q = c.req.query("status") as ForgeStatus | undefined;
  if (q && !STATUSES.includes(q)) return c.json({ error: "bad status", code: "bad_request" }, 400);
  const [rows, counts] = await Promise.all([listLatestTools(c.env, q), forgeCounts(c.env)]);
  return c.json({ tools: rows.map(toolSummary), counts, fuel_cap: forgeFuelCap(c.env) });
});

forgeRoutes.get("/tools/:name", async (c) => {
  const name = c.req.param("name");
  const v = c.req.query("version");
  const t = await getToolByName(c.env, name, v ? Number(v) : undefined);
  if (!t) return c.json({ error: "not found" }, 404);
  const [versions, runs, job] = await Promise.all([toolVersions(c.env, name), runsFor(c.env, t.id, 20), activeOrLastAdmission(c.env, t.id)]);
  const spec = specOf(t);
  return c.json({
    tool: {
      ...toolSummary(t),
      hash: t.hash,
      code: t.code,
      entry: spec.entry ?? "run",
      input_schema: spec.input_schema,
      output_schema: spec.output_schema ?? null,
      limits: spec.limits ?? null,
      effective_limits: effectiveLimits(spec.limits, forgeFuelCap(c.env)),
    },
    tests: testsSummary(spec.tests),
    report: t.report
      ? { status: t.report.status, reason: t.report.reason ?? null, gates: t.report.gates, warnings: t.report.warnings, stats: t.report.stats, at: t.report.at }
      : null,
    usage: { uses: t.uses, successes: t.successes, failures: t.failures, success_rate: successRate(t), last_used_at: t.last_used_at, recent_runs: runs },
    versions,
    job,
  });
});

async function activeOrLastAdmission(env: Env, toolId: string) {
  const active = await activeJobByKey(env, forgeAdmitKey(toolId));
  if (active) return publicJob(active);
  const r = await env.DB.prepare("SELECT id FROM jobs WHERE dedupe_key = ?1 ORDER BY created_at DESC LIMIT 1").bind(forgeAdmitKey(toolId)).first<{ id: string }>();
  if (!r) return null;
  const j = await getJob(env, r.id);
  return j ? publicJob(j) : null;
}

forgeRoutes.post("/submit", async (c) => {
  const body = await c.req.json<Partial<ForgeToolSpec>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "JSON object body required", code: "bad_request" }, 400);
  const spec = { ...body, author: "owner", lineage: typeof body.lineage === "string" && body.lineage.trim() ? body.lineage : "owner" } as ForgeToolSpec;
  const pre = precheckSpec(spec);
  if (!pre.ok) return c.json({ error: "structure gate failed", code: "invalid_spec", problems: pre.problems }, 422);
  if ((await new Governor(c.env).isKilled()).killed) return c.json({ error: "global kill switch is ON", code: "lab_killed" }, 423);
  const { tool, decided } = await stagePending(c.env, spec);
  if (decided) return c.json({ duplicate: true, tool: toolSummary(tool) }, 200);
  const init = await forgeAdmitInit(c.env, tool, "owner");
  const { job, reused } = await startJob(c.env, {
    kind: "forge.admit",
    params: { tool_id: tool.id, name: tool.name, version: tool.version, submitted_by: "owner" },
    state: init.state,
    total: init.total,
    max_calls: FORGE_ADMIT_CALLS,
    dedupe_key: forgeAdmitKey(tool.id),
  });
  await c.env.DB.prepare("UPDATE forge_tools SET status_reason = ?2 WHERE id = ?1 AND status = 'pending'").bind(tool.id, `admission running (job ${job.id})`).run();
  await audit(c.env.DB, "owner", "forge.submit", tool.id, { name: tool.name, version: tool.version, job: job.id });
  return c.json({ ...jobAccepted(job, reused), tool: toolSummary(tool) }, 202);
});

forgeRoutes.post("/tools/:name/run", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<{ input?: unknown; version?: number }>().catch(() => ({}) as { input?: unknown; version?: number });
  const t = await getToolByName(c.env, name, body.version === undefined ? undefined : Number(body.version));
  if (!t) return c.json({ error: "not found" }, 404);
  const input = body.input ?? {};
  if (t.status === "admitted") {
    // the real path agents use (input schema, output schema, plan limits), recorded as an owner call
    const r = await executeForgeTool(c.env, name, input, { caller: "owner", version: t.version });
    await audit(c.env.DB, "owner", "forge.test_run", t.id, { name, version: t.version, ok: r.ok, error_kind: r.errorKind ?? null });
    return c.json({ ok: r.ok, tool: name, version: t.version, status: t.status, value: r.value ?? null, error: r.error ?? null, error_kind: r.errorKind ?? null, ms: r.ms, fuel_used: r.fuelUsed, recorded: true });
  }
  // not admitted (pending / rejected / deprecated): sandbox only, never counted as usage
  const limits = effectiveLimits(t.spec.limits, forgeFuelCap(c.env));
  const r = await runSandboxed({ code: t.code, entry: t.spec.entry ?? "run", input, limits });
  await audit(c.env.DB, "owner", "forge.test_run", t.id, { name, version: t.version, ok: r.ok, error_kind: r.errorKind ?? null, status: t.status });
  return c.json({ ok: r.ok, tool: name, version: t.version, status: t.status, value: r.ok ? r.value : null, error: r.ok ? null : r.error ?? null, error_kind: r.ok ? null : r.errorKind ?? null, ms: r.ms, fuel_used: r.fuelUsed, recorded: false });
});

forgeRoutes.post("/tools/:name/retire", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  if (!(await getToolByName(c.env, name))) return c.json({ error: "not found" }, 404);
  const reason = `retired by owner${body.reason ? `: ${String(body.reason).slice(0, 200)}` : ""}`;
  const n = await retireToolName(c.env, name, reason);
  if (!n) return c.json({ error: "nothing to retire (no admitted or pending version)", code: "bad_state" }, 409);
  await audit(c.env.DB, "owner", "forge.retired", name, { versions: n, reason });
  const t = (await getToolByName(c.env, name))!;
  return c.json({ ok: true, retired_versions: n, tool: toolSummary(t) });
});
