import { Hono, type Context, type Next } from "hono";
import { home } from "./home/stub";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { CONSTITUTION, STATUSES, type AgentStatus } from "./constitution";
import type { Env, JobMessage } from "./env";
import { audit, listAudit, verifyAuditChain } from "./audit";
import { ApprovalError, decideApproval, listApprovals } from "./approvals";
import { authConfigured, checkOwnerCode, sessionEpoch } from "./auth/owner";
import { COOKIE_NAME, clearCookieHeader, cookieHeader, signSession, verifySession } from "./auth/session";
import { Governor, GovernorError } from "./governor/governor";
import { FREE_TIER } from "./governor/quotas";
import { keyList } from "./llm/keys";
import { DEFAULT_CHAIN } from "./llm/router";
import { Registry, RegistryError } from "./registry/registry";
import { seedStarterOrg } from "./registry/seed";
import { TOOLS } from "./tools/catalog";
import { evalRoutes } from "./eval/routes";
import { LabBudgetError } from "./eval/llm";
import { evalMaintenance } from "./eval/maintenance";
import { labFor } from "./eval/routes";
import { EngineError, tick as evolutionTick } from "./evolution/engine";
import { evolutionRoutes } from "./evolution/routes";
import { jobRoutes } from "./jobs/routes";
import { llmRoutes } from "./llm/routes";
import { kickJobs } from "./jobs/runner";
import { forgeRoutes } from "./forge/routes";
import { discoveryRoutes } from "./discovery/routes";
import { detectBudgetWarnings, hiveRoutes } from "./hive/routes";
import { recordOperatorNotes } from "./audit-notes";
import { applyEmbeddedMigrations, migrationStatus } from "./schema/apply";
import { today } from "./util";
import { mountRedteamRoutes } from "./redteam";
import { mountMemoryRoutes } from "./memory/routes";
import { mountCourtRoutes } from "./court/routes";
import { scheduleMemoryCompact } from "./memory/jobs";
import { scheduleCourtProbe } from "./court/jobs";
import { mountStudioRoutes } from "./studio";
import { mountArmyRoutes } from "./army/routes";
import { ARMY_JOB_HANDLERS } from "./army/swarm";
import { HANDLERS } from "./jobs/handlers";

// army.mission: registered after HANDLERS is declared (a static spread in jobs/handlers.ts would be an import cycle).
Object.assign(HANDLERS, ARMY_JOB_HANDLERS);

export { AgentHome } from "./home/AgentHome";
export { JobRunner } from "./jobs/runner";

type App = { Bindings: Env; Variables: { owner: boolean } };
const app = new Hono<App>();

const crossSite = (env: Env) => !!env.CONSOLE_ORIGIN;

// ---------- CORS (only when the console is hosted on a separate Pages origin) ----------
app.use("/api/*", async (c, next) => {
  const origin = c.env.CONSOLE_ORIGIN;
  if (!origin) return next();
  return cors({ origin, credentials: true, allowHeaders: ["content-type", "x-khaliya"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] })(c, next);
});

// ---------- security headers ----------
app.use("/api/*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
});

// ---------- errors ----------
app.onError((err, c) => {
  if (err instanceof RegistryError) {
    const code = err.code === "not_found" ? 404 : err.code === "invalid_genome" ? 422 : err.code === "protected" ? 403 : 409;
    return c.json({ error: err.message, code: err.code, details: err.details }, code);
  }
  if (err instanceof ApprovalError) {
    const code = err.code === "not_found" ? 404 : err.code === "step_up_required" ? 428 : err.code === "not_owner" ? 403 : 409;
    return c.json({ error: err.message, code: err.code }, code);
  }
  if (err instanceof GovernorError) return c.json({ error: err.message, code: err.code }, 429);
  if (err instanceof EngineError) {
    const code = err.code === "not_found" ? 404 : err.code === "bad_request" ? 400 : 409;
    return c.json({ error: err.message, code: err.code }, code);
  }
  if (err instanceof LabBudgetError) return c.json({ error: err.message, code: `lab_${err.scope}` }, err.scope === "killed" ? 423 : 429);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// ---------- public ----------
app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME ?? "Khaliya", auth_configured: authConfigured(c.env), time: Date.now() }));

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  const r = await checkOwnerCode(c.env, String(body.code ?? ""), "login");
  if (!r.ok) return c.json({ error: r.error }, r.status);
  const token = await signSession(c.env.SESSION_SECRET!, await sessionEpoch(c.env));
  c.header("set-cookie", cookieHeader(token, crossSite(c.env)));
  return c.json({ ok: true });
});

// ---------- owner gate: everything else under /api ----------
async function requireOwner(c: Context<App>, next: Next) {
  if (!authConfigured(c.env)) return c.json({ error: "owner auth not configured" }, 503);
  const s = await verifySession(c.env.SESSION_SECRET!, getCookie(c, COOKIE_NAME), await sessionEpoch(c.env));
  if (!s) return c.json({ error: "unauthorized" }, 401);
  // CSRF: mutating requests must carry the custom header (forces CORS preflight cross-site).
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-khaliya") !== "1") return c.json({ error: "missing x-khaliya header" }, 403);
  c.set("owner", true);
  await next();
}
app.use("/api/*", async (c, next) => {
  const p = c.req.path;
  if (p === "/api/health" || p === "/api/auth/login") return next();
  return requireOwner(c, next);
});

app.get("/api/auth/me", (c) => c.json({ owner: true }));
app.post("/api/auth/logout", async (c) => {
  c.header("set-cookie", clearCookieHeader(crossSite(c.env)));
  return c.json({ ok: true });
});
app.post("/api/auth/logout-all", async (c) => {
  const gov = new Governor(c.env);
  await gov.setState("auth.epoch", String((await sessionEpoch(c.env)) + 1));
  await audit(c.env.DB, "owner", "auth.logout_all");
  c.header("set-cookie", clearCookieHeader(crossSite(c.env)));
  return c.json({ ok: true });
});

// ---------- overview ----------
app.get("/api/overview", async (c) => {
  const env = c.env;
  const gov = new Governor(env);
  const [caps, usage, kill, killedAgents, counts, runsToday, pending] = await Promise.all([
    gov.caps(),
    gov.usage(),
    gov.isKilled(),
    gov.killedAgents(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM agents GROUP BY status").all<{ status: string; n: number }>(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM runs WHERE created_at >= ?1 GROUP BY status").bind(Date.parse(today() + "T00:00:00Z")).all<{ status: string; n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first<{ n: number }>(),
  ]);
  return c.json({
    day: today(),
    kill_global: kill.killed,
    killed_agents: killedAgents,
    agents: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
    runs_today: Object.fromEntries(runsToday.results.map((r) => [r.status, r.n])),
    pending_approvals: pending?.n ?? 0,
    caps,
    usage,
    providers: providerStatus(env),
  });
});

function providerStatus(env: Env) {
  return {
    mode: env.LLM_MODE ?? "auto",
    gemini: { configured: keyList(env.GEMINI_KEY).length > 0, keys: keyList(env.GEMINI_KEY).length, free_limits: FREE_TIER.providers.gemini },
    openrouter: { configured: keyList(env.OPENROUTER_KEY).length > 0, keys: keyList(env.OPENROUTER_KEY).length, free_limits: FREE_TIER.providers.openrouter, free_models_only: true },
    workers_ai: { configured: !!env.AI, free_limits: FREE_TIER.providers["workers-ai"] },
    default_chain: DEFAULT_CHAIN,
  };
}

// ---------- agents ----------
app.get("/api/agents", async (c) => {
  const gov = new Governor(c.env);
  const killed = new Set(await gov.killedAgents());
  const agents = await new Registry(c.env).listAgents();
  return c.json({ agents: agents.map((a) => ({ ...a, killed: killed.has(a.id) })) });
});

app.post("/api/agents", async (c) => {
  const body = await c.req.json<{ genome: any; id?: string; status?: AgentStatus }>();
  const reg = new Registry(c.env);
  const g = await reg.putGenome({ ...body.genome, created_by: body.genome?.created_by ?? "owner" }, "owner");
  const agent = await reg.createAgent(g, { id: body.id, status: body.status ?? "draft", actor: "owner" });
  return c.json({ agent, genome: g }, 201);
});

app.get("/api/agents/:id", async (c) => {
  const reg = new Registry(c.env);
  const a = await reg.getAgent(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  return c.json({ agent: a, genome: await reg.getGenome(a.genome_id) });
});

app.get("/api/agents/:id/desk", async (c) => {
  const id = c.req.param("id");
  const reg = new Registry(c.env);
  if (!(await reg.getAgent(id))) return c.json({ error: "not found" }, 404);
  const stub = home(c.env, id);
  const desk = await stub.desk(id);
  const killed = await new Governor(c.env).isKilled(id);
  return c.json({ ...desk, killed: killed.killed, kill_scope: killed.scope ?? null });
});

app.patch("/api/agents/:id/status", async (c) => {
  const { status } = await c.req.json<{ status: AgentStatus }>();
  if (!STATUSES.includes(status)) return c.json({ error: "bad status" }, 400);
  return c.json({ agent: await new Registry(c.env).setStatus(c.req.param("id"), status, "owner") });
});

app.post("/api/agents/:id/run", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ task?: string; wait?: boolean }>();
  const task = String(body.task ?? "").trim();
  if (!task || task.length > 4000) return c.json({ error: "task: 1-4000 chars" }, 400);
  if (!(await new Registry(c.env).getAgent(id))) return c.json({ error: "not found" }, 404);
  await audit(c.env.DB, "owner", "task.assign", id, { task: task.slice(0, 200) });
  const stub = home(c.env, id);
  if (body.wait) return c.json(await stub.runTask(id, task));
  const runId = await stub.enqueue(id, task);
  return c.json({ run_id: runId, status: "queued" }, 202);
});

app.post("/api/agents/:id/message", async (c) => {
  const id = c.req.param("id");
  const { text } = await c.req.json<{ text: string }>();
  if (!text) return c.json({ error: "text required" }, 400);
  if (!(await new Registry(c.env).getAgent(id))) return c.json({ error: "not found" }, 404);
  await home(c.env, id).deliver("owner", String(text));
  await audit(c.env.DB, "owner", "message.send", id);
  return c.json({ ok: true });
});

app.post("/api/agents/:id/kill", async (c) => {
  await new Governor(c.env).setKill({ agent: c.req.param("id") }, true);
  return c.json({ ok: true, killed: true });
});
app.post("/api/agents/:id/resume", async (c) => {
  await new Governor(c.env).setKill({ agent: c.req.param("id") }, false);
  return c.json({ ok: true, killed: false });
});

// ---------- genomes ----------
app.get("/api/genomes", async (c) => c.json({ genomes: await new Registry(c.env).listGenomes(c.req.query("lineage")) }));
app.get("/api/genomes/:id", async (c) => {
  const g = await new Registry(c.env).getGenome(c.req.param("id"));
  return g ? c.json({ genome: g }) : c.json({ error: "not found" }, 404);
});
app.post("/api/genomes", async (c) => {
  const body = await c.req.json<any>();
  const g = await new Registry(c.env).putGenome({ ...body, created_by: body?.created_by ?? "owner" }, "owner");
  return c.json({ genome: g }, 201);
});
app.get("/api/deployments", async (c) => c.json({ deployments: await new Registry(c.env).deployments() }));

// ---------- runs ----------
app.get("/api/runs", async (c) => {
  const agent = c.req.query("agent");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const cols = "id, agent_id, genome_id, task, status, stop_reason, steps, tokens, tool_calls, llm_calls, wall_ms, created_at, finished_at";
  const q = agent
    ? c.env.DB.prepare(`SELECT ${cols} FROM runs WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT ?2`).bind(agent, limit)
    : c.env.DB.prepare(`SELECT ${cols} FROM runs ORDER BY created_at DESC LIMIT ?1`).bind(limit);
  return c.json({ runs: (await q.all()).results });
});
app.get("/api/runs/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ?1").bind(c.req.param("id")).first<any>();
  if (!r) return c.json({ error: "not found" }, 404);
  let trace: unknown = null;
  try {
    trace = await home(c.env, r.agent_id).traceFor(r.id);
  } catch {}
  if (!trace || (Array.isArray(trace) && trace.length === 0)) trace = r.trace ? JSON.parse(r.trace) : [];
  return c.json({ run: { ...r, trace: undefined }, trace });
});

// ---------- approvals ----------
app.get("/api/approvals", async (c) => c.json({ approvals: await listApprovals(c.env.DB, c.req.query("status") || undefined) }));
app.post("/api/approvals/:id/:decision{approve|reject}", async (c) => {
  const body = await c.req.json<{ code?: string; note?: string }>().catch(() => ({}) as { code?: string; note?: string });
  const decision = c.req.param("decision") as "approve" | "reject";
  let stepUpOk = false;
  if (decision === "approve" && body.code) {
    const r = await checkOwnerCode(c.env, String(body.code), "step_up");
    if (!r.ok) return c.json({ error: r.error }, r.status);
    stepUpOk = true;
  }
  const row = await decideApproval(c.env, c.req.param("id"), decision, { actor: "owner", stepUpOk, note: body.note });
  return c.json({ approval: row });
});

// ---------- governor / kill switch ----------
app.get("/api/governor", async (c) => {
  const gov = new Governor(c.env);
  return c.json({
    constitution: CONSTITUTION,
    caps: await gov.caps(),
    overrides: await gov.overrides(),
    kill_global: (await gov.isKilled()).killed,
    killed_agents: await gov.killedAgents(),
    usage: await gov.usage(),
    free_tier: FREE_TIER,
  });
});
app.post("/api/governor/kill", async (c) => {
  const { on } = await c.req.json<{ on: boolean }>();
  await new Governor(c.env).setKill("global", !!on);
  return c.json({ ok: true, kill_global: !!on });
});
app.post("/api/governor/caps", async (c) => {
  const body = await c.req.json<{ margin?: number; population_live?: number }>();
  const gov = new Governor(c.env);
  await gov.setOverrides(body);
  return c.json({ caps: await gov.caps(), overrides: await gov.overrides() });
});

// ---------- audit ----------
app.get("/api/audit", async (c) => {
  const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
  return c.json({ entries: await listAudit(c.env.DB, Number(c.req.query("limit") ?? 100), before) });
});
app.get("/api/audit/verify", async (c) => c.json(await verifyAuditChain(c.env.DB)));

// ---------- tools / settings / seed ----------
app.get("/api/tools", (c) => c.json({ tools: TOOLS.map(({ handler: _h, ...t }) => t), tiers: CONSTITUTION.tiers, role_max_tier: CONSTITUTION.roleMaxTier }));
app.get("/api/settings", async (c) =>
  c.json({
    app: c.env.APP_NAME ?? "Khaliya",
    providers: providerStatus(c.env),
    auth: { configured: authConfigured(c.env), method: "TOTP + signed HttpOnly cookie", cross_site_console: crossSite(c.env) },
    secrets_note: "Keys live in Worker secrets (wrangler secret put). They are never returned by the API.",
    queues: { enabled: !!c.env.JOBS },
    population_cap: (await new Governor(c.env).caps()).population,
  }),
);
app.post("/api/seed", async (c) => c.json(await seedStarterOrg(c.env, "owner")));

// ---------- schema (additive embedded migrations 0004/0005; see src/schema/apply.ts) ----------
app.get("/api/admin/migrations", async (c) => c.json(await migrationStatus(c.env)));
app.post("/api/admin/migrations/apply", async (c) => {
  const applied = await applyEmbeddedMigrations(c.env, "owner");
  return c.json({ applied, ...(await migrationStatus(c.env)) });
});

// ---------- eval factory (owner-only; see src/eval/routes.ts) ----------
app.route("/api/evals", evalRoutes);
// ---------- evolution loop (owner-only; see src/evolution/routes.ts) ----------
app.route("/api/evolution", evolutionRoutes);
// ---------- background jobs (owner-only; see src/jobs/routes.ts) ----------
app.route("/api/jobs", jobRoutes);
// ---------- LLM diagnostics: ping a model, list Gemini models, budget (owner-only; see src/llm/routes.ts) ----------
app.route("/api/llm", llmRoutes);
// ---------- Tool Forge (owner-only; see src/forge/routes.ts) ----------
app.route("/api/forge", forgeRoutes);
// ---------- Discovery Lab (owner-only; see src/discovery/routes.ts) ----------
app.route("/api/discovery", discoveryRoutes);
// ---------- living hive: event stream + pulse (owner-only; see src/hive/routes.ts) ----------
app.route("/api/hive", hiveRoutes);
// ---------- Red-Team Arena (owner-only; see src/redteam/routes.ts) ----------
mountRedteamRoutes(app);
// ---------- Org Memory / KB + Judge Court (owner-only; see src/memory/routes.ts, src/court/routes.ts) ----------
mountMemoryRoutes(app); // /api/kb/*
mountCourtRoutes(app); // /api/court/*
// ---------- Agent Studio + the Army (P16, owner-only; see src/studio/routes.ts, src/army/routes.ts) ----------
mountStudioRoutes(app); // /api/studio/*
mountArmyRoutes(app); // /api/army/*

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// Non-API paths: the console (static assets). With run_worker_first=["/api/*"] these rarely reach the Worker.
app.all("*", async (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Khaliya API", 200)));

// ---------- scheduled + queue ----------
export async function healthTick(env: Env) {
  try {
    await applyEmbeddedMigrations(env, "system"); // safety net: Forge/Discovery tables exist after a deploy
  } catch (e) {
    console.error("embedded migrations failed", e);
  }
  // Anomaly auto-pause (skeleton): ≥5 failed/capped runs in the last hour → kill that agent.
  const since = Date.now() - 60 * 60 * 1000;
  const bad = (
    await env.DB.prepare("SELECT agent_id, COUNT(*) AS n FROM runs WHERE created_at >= ?1 AND status IN ('failed') GROUP BY agent_id HAVING n >= 5")
      .bind(since)
      .all<{ agent_id: string; n: number }>()
  ).results;
  const gov = new Governor(env);
  for (const b of bad) {
    if (!(await gov.isKilled(b.agent_id)).killed) {
      await gov.setKill({ agent: b.agent_id }, true, "governor");
      await audit(env.DB, "governor", "anomaly.autopause", b.agent_id, { failed_last_hour: b.n });
    }
  }
  try {
    await detectBudgetWarnings(env); // 80% / 100% ledger crossings → hive events
  } catch (e) {
    console.error("budget warning detection failed", e);
  }
  try {
    await recordOperatorNotes(env); // one-time audit notes for manual interventions on the live DB
  } catch (e) {
    console.error("operator notes failed", e);
  }
}

/** LLM call ceiling for one automatic (cron) evolution tick. */
export const AUTO_EVOLUTION_CALLS = 300;

/**
 * Whether this half-hourly cron run should also run an evolution tick: only when EVOLUTION_AUTO === "on" (default off)
 * and only on the top-of-the-hour run (minute < 30), i.e. at most hourly.
 */
export function shouldAutoEvolve(env: Env, scheduledTime: number): boolean {
  if ((env.EVOLUTION_AUTO ?? "off") !== "on") return false;
  return new Date(scheduledTime).getUTCMinutes() < 30;
}

/** One automatic evolution tick (maxProposals 1). Never throws: a failed tick must not break the health tick. */
export async function autoEvolve(env: Env, scheduledTime: number): Promise<"skipped" | "killed" | "ran" | "failed"> {
  if (!shouldAutoEvolve(env, scheduledTime)) return "skipped";
  try {
    if ((await new Governor(env).isKilled()).killed) return "killed";
    await evolutionTick(env, labFor(env, AUTO_EVOLUTION_CALLS), { maxProposals: 1, holder: `cron:${scheduledTime}` });
    return "ran";
  } catch (e) {
    console.error("auto evolution tick failed", e);
    try {
      await audit(env.DB, "system", "evolution.auto_failed", null, { error: String((e as Error)?.message ?? e).slice(0, 300) });
    } catch {}
    return "failed";
  }
}

async function dailyMaintenance(env: Env) {
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_cache WHERE expires_at < ?1").bind(Date.now()),
    env.DB.prepare("DELETE FROM budgets WHERE day < ?1").bind(cutoff),
    env.DB.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND created_at < ?1").bind(Date.now() - 7 * 86400_000),
  ]);
  await audit(env.DB, "system", "maintenance.daily");
  await evalMaintenance(env);
  try {
    await scheduleMemoryCompact(env);
  } catch (e) {
    console.error("memory.compact schedule failed", e);
  }
  try {
    await scheduleCourtProbe(env, labFor(env, 0));
  } catch (e) {
    console.error("court.probe schedule failed", e);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "5 0 * * *") ctx.waitUntil(dailyMaintenance(env));
    else {
      ctx.waitUntil(healthTick(env));
      ctx.waitUntil(autoEvolve(env, controller.scheduledTime));
      ctx.waitUntil(kickJobs(env)); // safety net: resumes a job whose alarm chain was lost
    }
  },
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    for (const m of batch.messages) {
      const job = m.body;
      if (job.kind === "run") {
        await home(env, job.agent_id).runTask(job.agent_id, job.task, { runId: job.run_id });
      } else if (job.kind === "tick") {
        await healthTick(env);
      }
      m.ack();
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

export { app };
