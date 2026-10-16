/**
 * Owner-only Army API. `mountArmyRoutes(app)` mounts it at /api/army. The sub-app carries its OWN owner guard
 * (session cookie + x-khaliya CSRF header on mutations), so it stays owner-only even if mounted before the global
 * gate in index.ts. Errors are mapped here (index.ts's onError does not know army error classes).
 *
 *   GET  /api/army/overview                         → {divisions:[{…, counts}], ranks, ladder, counts, kill}
 *   GET  /api/army/ranks                            → {ranks:[RankRow]}
 *   POST /api/army/ranks/:agent_id/review           → ReviewResult
 *   POST /api/army/ranks/:agent_id {rank?,division?,court_score?,owner_accepted?} → {rank}
 *   POST /api/army/incidents {agent_id, kind, severity, detail?}  → 201 {id, review}
 *   GET  /api/army/passports ?agent_id&live=1        → {passports}
 *   POST /api/army/passports {agent_id, autonomy?, ttl_days?} → 201 {token, passport}
 *   POST /api/army/passports/verify {token}         → {ok, reason?, passport?}
 *   POST /api/army/passports/:id/revoke {reason}    → {revoked}
 *   GET  /api/army/capabilities ?agent_id&mission_id&live=1 → {capabilities, revocations}
 *   POST /api/army/capabilities {agent_id, tools, max_tier?, tiers?, data_scopes?, egress?, ttl_s?, max_calls?,
 *                                spend_cap_usd?, mission_id?, parent?, keys?, code?} → 201 {token, capability}
 *   POST /api/army/capabilities/check {token, action} → {ok, reason?, violation?}   (dry run: no call consumed)
 *   POST /api/army/capabilities/:id/revoke {reason} → {revoked}
 *   GET  /api/army/missions ?status                 → {missions}
 *   POST /api/army/missions MissionInput            → 201 {mission}
 *   GET  /api/army/missions/:id                     → {mission, job_id}
 *   POST /api/army/missions/:id/approve {code?, keys?, note?} → {mission}   (owner session; step-up via code)
 *   POST /api/army/missions/:id/start               → 202 {job_id, job, poll, reused}
 *   POST /api/army/missions/:id/rollback {reason}   → {mission}
 *   GET  /api/army/matrix                           → {matrix, ladder, two_key_classes, l5_max_days, approvers}
 *   POST /api/army/matrix/check {action_class, risk, level, keys?, requester?} → {requirement, check}
 *   GET  /api/army/kill                             → snapshot;  POST /api/army/kill {scope: division|mission, id, on}
 *   GET  /api/army/audit ?limit                     → {entries}
 *   GET  /api/army/audit/verify                     → {ok, checked, head, broken_at?, reason?}
 */
import { Hono, type Context, type Next } from "hono";
import { getCookie } from "hono/cookie";
import { authConfigured, checkOwnerCode, clientIp, sessionEpoch } from "../auth/owner";
import { COOKIE_NAME, verifySession } from "../auth/session";
import type { Env } from "../env";
import { listArmyAudit, verifyChain } from "./audit";
import { ACTION_CLASSES, APPROVERS, type ApprovalKey, AUTONOMY_LADDER, checkApprovals, isActionClass, isAutonomy, isRisk, L5_MAX_DAYS, matrixTable, requiredApprovals, TWO_KEY_CLASSES } from "./autonomy";
import { CapabilityError, checkCapability, listCapabilities, mintCapability, revocationList, revokeCapability, verifyCapabilitySig } from "./capability";
import { armySecret } from "./crypto";
import { DIVISIONS, isDivision } from "./divisions";
import { killSnapshot, KillSwitchError, setArmyKill } from "./killswitch";
import { approveMission, createMission, getMission, listMissions, MissionError, rollbackMission } from "./missions";
import { issuePassport, listPassports, PassportError, revokePassport, verifyPassport } from "./passport";
import { INCIDENT_KINDS, isRank, ownerSetRank, RANK_DEFS, recordIncident, reviewRank, type IncidentKind } from "./ranks";
import { registerArmyJobs, startMission } from "./swarm";

type R = { Bindings: Env };
export const armyRoutes = new Hono<R>();

const body = async (c: Context<R>) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, any>;

async function ownerGuard(c: Context<R>, next: Next) {
  if (!authConfigured(c.env)) return c.json({ error: "owner auth not configured" }, 503);
  const s = await verifySession(c.env.SESSION_SECRET!, getCookie(c, COOKIE_NAME), await sessionEpoch(c.env));
  if (!s) return c.json({ error: "unauthorized" }, 401);
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-khaliya") !== "1") return c.json({ error: "missing x-khaliya header" }, 403);
  await next();
}
armyRoutes.use("*", ownerGuard);

function mapError(c: Context<R>, e: unknown) {
  if (e instanceof MissionError) {
    const s = e.code === "not_found" ? 404 : e.code === "bad_request" || e.code === "forbidden" || e.code === "verifier_conflict" ? 400 : e.code === "not_owner" ? 403 : e.code === "step_up_required" ? 428 : e.code === "killed" ? 423 : 409;
    return c.json({ error: e.message, code: e.code, details: e.details }, s);
  }
  if (e instanceof CapabilityError) return c.json({ error: e.message, code: e.code, details: e.details }, e.code === "two_key_required" ? 428 : 400);
  if (e instanceof PassportError) return c.json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 400);
  if (e instanceof KillSwitchError) return c.json({ error: e.message, code: e.code }, e.code === "not_owner" ? 403 : 400);
  throw e;
}
const wrap = (fn: (c: Context<R>) => Promise<Response>) => async (c: Context<R>) => {
  try {
    return await fn(c);
  } catch (e) {
    return mapError(c, e);
  }
};

/** Optional step-up: a fresh TOTP in body.code. Returns true/false, or a Response on a bad code. */
async function stepUp(c: Context<R>, code: unknown): Promise<boolean | Response> {
  if (code === undefined || code === null || code === "") return false;
  const r = await checkOwnerCode(c.env, String(code), "step_up", Date.now(), { ip: clientIp(c.req.raw) });
  if (!r.ok) return c.json({ error: r.error, code: "step_up_failed" }, r.status);
  return true;
}

function cleanKeys(v: unknown): ApprovalKey[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((k) => k && typeof k === "object" && ["court", "security_council"].includes(k.approver) && typeof k.by === "string" && k.by && k.by !== "owner")
    .slice(0, 4)
    .map((k) => ({ approver: k.approver, by: String(k.by).slice(0, 80), division: typeof k.division === "string" ? k.division : null }));
}

// ---------------------------------------------------------------- overview / ranks
armyRoutes.get(
  "/overview",
  wrap(async (c) => {
    const ranks = (await c.env.DB.prepare("SELECT division, rank, COUNT(*) AS n FROM army_ranks GROUP BY division, rank").all<{ division: string; rank: string; n: number }>()).results;
    const missions = (await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM army_missions GROUP BY status").all<{ status: string; n: number }>()).results;
    const now = Date.now();
    const pp = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM army_passports WHERE revoked_at IS NULL AND expires_at > ?1").bind(now).first<{ n: number }>();
    const caps = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM army_capabilities WHERE revoked_at IS NULL AND expires_at > ?1").bind(now).first<{ n: number }>();
    const inc = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM army_incidents WHERE at > ?1").bind(now - 7 * 86_400_000).first<{ n: number }>();
    return c.json({
      divisions: DIVISIONS.map((d) => ({ ...d, counts: Object.fromEntries(RANK_DEFS.map((r) => [r.rank, ranks.find((x) => x.division === d.id && x.rank === r.rank)?.n ?? 0])), total: ranks.filter((x) => x.division === d.id).reduce((a, x) => a + x.n, 0) })),
      ranks: RANK_DEFS,
      ladder: AUTONOMY_LADDER,
      counts: { agents: ranks.reduce((a, x) => a + x.n, 0), live_passports: pp?.n ?? 0, live_capabilities: caps?.n ?? 0, incidents_7d: inc?.n ?? 0, missions: Object.fromEntries(missions.map((m) => [m.status, m.n])) },
      kill: await killSnapshot(c.env),
    });
  }),
);

armyRoutes.get("/ranks", wrap(async (c) => c.json({ ranks: (await c.env.DB.prepare("SELECT * FROM army_ranks ORDER BY division, rank DESC, agent_id LIMIT 500").all()).results })));

armyRoutes.post("/ranks/:agent_id/review", wrap(async (c) => c.json(await reviewRank(c.env, c.req.param("agent_id")!, "owner"))));

armyRoutes.post(
  "/ranks/:agent_id",
  wrap(async (c) => {
    const b = await body(c);
    if (b.rank !== undefined && !isRank(b.rank)) return c.json({ error: "rank must be R0..R4" }, 400);
    if (b.division !== undefined && !isDivision(b.division)) return c.json({ error: "unknown division" }, 400);
    return c.json({ rank: await ownerSetRank(c.env, c.req.param("agent_id")!, { rank: b.rank, division: b.division, court_score: b.court_score, owner_accepted: b.owner_accepted }, "owner") });
  }),
);

armyRoutes.post(
  "/incidents",
  wrap(async (c) => {
    const b = await body(c);
    if (typeof b.agent_id !== "string" || !INCIDENT_KINDS.includes(b.kind)) return c.json({ error: `{agent_id, kind ∈ ${INCIDENT_KINDS.join("|")}, severity 1..4}` }, 400);
    const id = await recordIncident(c.env, b.agent_id, b.kind as IncidentKind, Number(b.severity ?? 1), b.detail, "owner");
    return c.json({ id, review: await reviewRank(c.env, b.agent_id, "owner") }, 201);
  }),
);

// ---------------------------------------------------------------- passports
armyRoutes.get("/passports", wrap(async (c) => c.json({ passports: await listPassports(c.env, { agent_id: c.req.query("agent_id") || undefined, live: c.req.query("live") === "1" }) })));

armyRoutes.post(
  "/passports",
  wrap(async (c) => {
    const b = await body(c);
    if (typeof b.agent_id !== "string" || !b.agent_id) return c.json({ error: "agent_id is required" }, 400);
    if (b.autonomy !== undefined && !isAutonomy(b.autonomy)) return c.json({ error: "autonomy must be L0..L4" }, 400);
    const ttl = b.ttl_days === undefined ? undefined : Math.max(1, Math.min(30, Number(b.ttl_days))) * 86_400_000;
    return c.json(await issuePassport(c.env, b.agent_id, { autonomy: b.autonomy, ttl_ms: ttl, actor: "owner" }), 201);
  }),
);

armyRoutes.post(
  "/passports/verify",
  wrap(async (c) => {
    const b = await body(c);
    if (typeof b.token !== "string") return c.json({ error: "token is required" }, 400);
    return c.json(await verifyPassport(c.env, b.token));
  }),
);

armyRoutes.post(
  "/passports/:id/revoke",
  wrap(async (c) => {
    const b = await body(c);
    return c.json({ revoked: await revokePassport(c.env, c.req.param("id")!, typeof b.reason === "string" && b.reason ? b.reason : "owner", "owner") });
  }),
);

// ---------------------------------------------------------------- capabilities
armyRoutes.get(
  "/capabilities",
  wrap(async (c) =>
    c.json({
      capabilities: await listCapabilities(c.env, { agent_id: c.req.query("agent_id") || undefined, mission_id: c.req.query("mission_id") || undefined, live: c.req.query("live") === "1" }),
      revocations: await revocationList(c.env),
    }),
  ),
);

armyRoutes.post(
  "/capabilities",
  wrap(async (c) => {
    const b = await body(c);
    const su = await stepUp(c, b.code);
    if (su instanceof Response) return su;
    const keys: ApprovalKey[] = [{ approver: "owner", by: "owner", step_up: su }, ...cleanKeys(b.keys)];
    const { token, body: cap } = await mintCapability(
      c.env,
      { agent_id: b.agent_id, mission_id: b.mission_id ?? null, tools: b.tools, max_tier: b.max_tier, tiers: b.tiers, data_scopes: b.data_scopes, egress: b.egress, ttl_s: b.ttl_s, max_calls: b.max_calls, spend_cap_usd: b.spend_cap_usd },
      { actor: "owner", keys, parent: typeof b.parent === "string" ? b.parent : undefined },
    );
    return c.json({ token, capability: cap }, 201);
  }),
);

armyRoutes.post(
  "/capabilities/check",
  wrap(async (c) => {
    const b = await body(c);
    if (typeof b.token !== "string" || !b.action || typeof b.action.tool_id !== "string") return c.json({ error: "{token, action:{tool_id, tier, …}}" }, 400);
    const v = await verifyCapabilitySig(armySecret(c.env), b.token);
    if (!v.ok) return c.json({ ok: false, reason: v.reason, violation: false });
    const row = await c.env.DB.prepare("SELECT calls_used FROM army_capabilities WHERE id = ?1").bind(v.body.token_id).first<{ calls_used: number }>();
    if (!row) return c.json({ ok: false, reason: "unknown", violation: false });
    return c.json(checkCapability(v.body, { ...b.action, tier: Number(b.action.tier ?? 0) }, { calls_used: row.calls_used, revoked: await revocationList(c.env) }));
  }),
);

armyRoutes.post(
  "/capabilities/:id/revoke",
  wrap(async (c) => {
    const b = await body(c);
    return c.json({ revoked: await revokeCapability(c.env, c.req.param("id")!, typeof b.reason === "string" && b.reason ? b.reason : "owner", "owner") });
  }),
);

// ---------------------------------------------------------------- missions
armyRoutes.get("/missions", wrap(async (c) => c.json({ missions: await listMissions(c.env, { status: c.req.query("status") || undefined, limit: Number(c.req.query("limit") ?? 50) || 50 }) })));

armyRoutes.post("/missions", wrap(async (c) => c.json({ mission: await createMission(c.env, (await body(c)) as any, "owner") }, 201)));

armyRoutes.get(
  "/missions/:id",
  wrap(async (c) => {
    const m = await getMission(c.env, c.req.param("id")!);
    if (!m) return c.json({ error: "not_found" }, 404);
    return c.json({ mission: m, job_id: m.job_id });
  }),
);

armyRoutes.post(
  "/missions/:id/approve",
  wrap(async (c) => {
    const b = await body(c);
    const su = await stepUp(c, b.code);
    if (su instanceof Response) return su;
    return c.json({ mission: await approveMission(c.env, c.req.param("id")!, { actor: "owner", stepUpOk: su, keys: cleanKeys(b.keys), note: typeof b.note === "string" ? b.note : undefined }) });
  }),
);

armyRoutes.post("/missions/:id/start", wrap(async (c) => c.json(await startMission(c.env, c.req.param("id")!, "owner"), 202)));

armyRoutes.post(
  "/missions/:id/rollback",
  wrap(async (c) => {
    const b = await body(c);
    return c.json({ mission: await rollbackMission(c.env, c.req.param("id")!, typeof b.reason === "string" && b.reason ? b.reason : "owner rollback", "owner") });
  }),
);

// ---------------------------------------------------------------- matrix
armyRoutes.get("/matrix", (c) => c.json({ matrix: matrixTable(), ladder: AUTONOMY_LADDER, two_key_classes: TWO_KEY_CLASSES, l5_max_days: L5_MAX_DAYS, approvers: APPROVERS, action_classes: ACTION_CLASSES }));

armyRoutes.post(
  "/matrix/check",
  wrap(async (c) => {
    const b = await body(c);
    const risk = Number(b.risk);
    if (!isActionClass(b.action_class) || !isRisk(risk) || (b.level !== undefined && !isAutonomy(b.level))) return c.json({ error: "{action_class, risk 0..4, level L0..L5}" }, 400);
    const req = requiredApprovals(b.action_class, risk, b.level ?? "L0");
    const keys: ApprovalKey[] = [...(b.owner_key ? [{ approver: "owner" as const, by: "owner", step_up: !!b.owner_step_up }] : []), ...cleanKeys(b.keys)];
    return c.json({ requirement: req, check: checkApprovals(req, keys, { id: String(b.requester?.id ?? ""), division: b.requester?.division ?? null }) });
  }),
);

// ---------------------------------------------------------------- kill switches
armyRoutes.get("/kill", wrap(async (c) => c.json(await killSnapshot(c.env))));

armyRoutes.post(
  "/kill",
  wrap(async (c) => {
    const b = await body(c);
    if (b.scope !== "division" && b.scope !== "mission") return c.json({ error: "scope must be division | mission (org/agent: use /api/kill and /api/agents/:id/kill)" }, 400);
    await setArmyKill(c.env, b.scope, String(b.id ?? ""), !!b.on, "owner");
    return c.json(await killSnapshot(c.env));
  }),
);

// ---------------------------------------------------------------- audit
armyRoutes.get("/audit", wrap(async (c) => c.json({ entries: await listArmyAudit(c.env.DB, Number(c.req.query("limit") ?? 100) || 100) })));
armyRoutes.get("/audit/verify", wrap(async (c) => c.json(await verifyChain(c.env.DB))));

/** Mount at /api/army (safe before or after the owner gate — the sub-app guards itself). */
export function mountArmyRoutes(app: Hono<any>): void {
  registerArmyJobs();
  app.route("/api/army", armyRoutes);
}
