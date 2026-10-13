import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { sessionEpoch } from "../../src/auth/owner";
import { COOKIE_NAME, signSession } from "../../src/auth/session";
import { verifyChain } from "../../src/army/audit";
import { setArmyKill } from "../../src/army/killswitch";
import { approveMission, createMission, getMission, type MissionInput } from "../../src/army/missions";
import { mountArmyRoutes } from "../../src/army/routes";
import { ARMY_MISSION_KIND, evaluateCriteria, registerArmyJobs, startMission } from "../../src/army/swarm";
import { Governor } from "../../src/governor/governor";
import { HANDLERS } from "../../src/jobs/handlers";
import { drainJob } from "../../src/jobs/runner";
import { freshState } from "../helpers";

const E = env as Env;
const T = 110_000;
beforeEach(async () => {
  await freshState();
  registerArmyJobs();
});

const SCOPE = { tools: ["think", "memory.search", "memory.write"], max_tier: 1 as const };
const mission = (over: Partial<MissionInput> = {}): MissionInput => ({
  goal: "Prepare an internal summary of open tasks",
  rollback_plan: ["discard the summary draft"],
  scope: SCOPE,
  budget: { llm_calls: 20 },
  subtasks: [
    { title: "recall open tasks", tool: "memory.search", tier: 0 },
    { title: "think through priorities", tool: "think", tier: 0 },
    { title: "write the summary note", tool: "memory.write", tier: 0 },
    { title: "double check the summary", tool: "think", tier: 0 },
  ],
  success_criteria: [{ id: "all", kind: "all_subtasks_ok" }, { id: "nd", kind: "no_denials" }, { id: "txt", kind: "output_contains", value: "summary" }],
  ...over,
});

async function runMission(input: MissionInput) {
  const m = await createMission(E, input);
  await approveMission(E, m.id, { actor: "owner" });
  const acc = await startMission(E, m.id);
  const job = await drainJob(E, acc.job_id);
  return { job, mission: (await getMission(E, m.id))! };
}

describe("army.mission swarm job (mock mode)", () => {
  it("registers the job kind once", () => {
    registerArmyJobs();
    expect(HANDLERS[ARMY_MISSION_KIND]).toBeTruthy();
  });

  it("planner → workers → verifier end-to-end: done, ≤ 1 LLM call per step, deterministic", { timeout: T }, async () => {
    const { job, mission: m } = await runMission(mission());
    expect(job.status).toBe("done");
    expect(m.status).toBe("done");
    const r = job.result as any;
    expect(r.outcome).toBe("done");
    expect(r.subtasks.map((s: any) => s.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(r.verdict.pass).toBe(true);
    // 1 plan + 4 workers + 1 verifier
    expect(job.llm_calls).toBe(6);
    // One worker capability token per subtask, each a child of the mission root.
    const caps = (await E.DB.prepare("SELECT parent_id FROM army_capabilities WHERE mission_id = ?1").bind(m.id).all<{ parent_id: string | null }>()).results;
    expect(caps.filter((c) => c.parent_id === null).length).toBe(1);
    expect(caps.filter((c) => c.parent_id !== null).length).toBe(4);
    expect((await verifyChain(E.DB)).ok).toBe(true);
    // Deterministic: same mission again → identical subtask plan and outcome.
    const again = await runMission(mission());
    expect((again.job.result as any).subtasks.map((s: any) => [s.title, s.tool, s.status])).toEqual(r.subtasks.map((s: any) => [s.title, s.tool, s.status]));
  });

  it("workers can only use tools in their capability token: one denial fails verification → rolled back", { timeout: T }, async () => {
    const subs = mission().subtasks!.slice(0, 3).concat([{ title: "send an email", tool: "email.send", tier: 4 as any }]);
    const { job, mission: m } = await runMission(mission({ subtasks: subs }));
    const r = job.result as any;
    expect(r.subtasks[3]).toMatchObject({ status: "denied", reason: "tool_not_allowed" });
    expect(r.verdict.pass).toBe(false);
    expect(m.status).toBe("rolled_back");
    expect((m.rollback as any).steps[0].status).toBe("executed");
    const inc = await E.DB.prepare("SELECT kind FROM army_incidents WHERE agent_id = ?1").bind(r.subtasks[3].agent).first<{ kind: string }>();
    expect(inc?.kind).toBe("scope_violation");
  });

  it("circuit breaker: > 30 % failed subtasks stops the swarm and rolls back", { timeout: T }, async () => {
    const subs = [
      { title: "a", tool: "http.get", tier: 3 as any },
      { title: "b", tool: "web.publish", tier: 4 as any },
      { title: "c", tool: "think", tier: 0 as any },
      { title: "d", tool: "think", tier: 0 as any },
    ];
    const { job, mission: m } = await runMission(mission({ subtasks: subs }));
    const r = job.result as any;
    expect(r.stopped).toBe("circuit_breaker");
    expect(r.subtasks.filter((s: any) => s.status === "pending").length).toBe(2); // stopped early
    expect(m.status).toBe("rolled_back");
  });

  it("mission kill switch stops the swarm; division and org (Governor, read-only) switches block start", { timeout: T }, async () => {
    const m = await createMission(E, mission());
    await approveMission(E, m.id, { actor: "owner" });
    const acc = await startMission(E, m.id);
    await setArmyKill(E, "mission", m.id, true, "owner");
    const job = await drainJob(E, acc.job_id);
    expect((job.result as any).outcome).toBe("killed");
    expect((await getMission(E, m.id))!.status).toBe("rolled_back");

    const d = await createMission(E, mission({ division: "researchers" }));
    await approveMission(E, d.id, { actor: "owner" });
    await setArmyKill(E, "division", "researchers", true, "owner");
    await expect(startMission(E, d.id)).rejects.toMatchObject({ code: "killed" });
    await setArmyKill(E, "division", "researchers", false, "owner");
    await new Governor(E).setKill("global", true, "owner"); // existing org switch (test sets it; army only reads)
    await expect(startMission(E, d.id)).rejects.toMatchObject({ code: "killed" });
    await expect(setArmyKill(E, "division", "researchers", true, "agent:x")).rejects.toMatchObject({ code: "not_owner" });
  });

  it("budget stop mid-swarm never leaves the mission running", { timeout: T }, async () => {
    const { job, mission: m } = await runMission(mission({ budget: { llm_calls: 3 } }));
    expect(job.stopped).toBe("budget");
    expect(["rolled_back"]).toContain(m.status);
  });

  it("criteria evaluation is pure", () => {
    const subs: any[] = [{ status: "ok", output: "Summary ready" }, { status: "denied" }];
    const r = evaluateCriteria([{ id: "a", kind: "min_subtasks_ok", value: 1 }, { id: "b", kind: "max_failure_rate", value: 0.5 }, { id: "c", kind: "output_contains", value: "summary" }, { id: "d", kind: "no_denials" }], subs);
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false]);
  });
});

describe("owner-only army routes", () => {
  const app = new Hono<{ Bindings: Env }>();
  mountArmyRoutes(app);
  const call = async (cookie: string | null, path: string, init: { method?: string; body?: unknown; csrf?: boolean } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    if (init.csrf !== false) headers["x-khaliya"] = "1";
    const res = await app.request(`https://k.test${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, E);
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const ownerCookie = async () => `${COOKIE_NAME}=${await signSession(E.SESSION_SECRET!, await sessionEpoch(E))}`;

  it("rejects missing session and missing CSRF header", async () => {
    expect((await call(null, "/api/army/overview")).status).toBe(401);
    expect((await call("khaliya_session=bogus.sig", "/api/army/matrix")).status).toBe(401);
    const ck = await ownerCookie();
    expect((await call(ck, "/api/army/missions", { method: "POST", body: { goal: "x" }, csrf: false })).status).toBe(403);
  });

  it("overview, matrix, passports, capabilities, missions (create/approve/start/get), audit verify", { timeout: T }, async () => {
    const ck = await ownerCookie();
    const ov = await call(ck, "/api/army/overview");
    expect(ov.status).toBe(200);
    expect(ov.json.divisions.length).toBe(9);
    expect(ov.json.ranks.map((r: any) => r.rank)).toEqual(["R0", "R1", "R2", "R3", "R4"]);

    const mx = await call(ck, "/api/army/matrix");
    expect(mx.json.two_key_classes).toEqual(["money", "publish", "external_comms", "data_export"]);
    const chk = await call(ck, "/api/army/matrix/check", { method: "POST", body: { action_class: "money", risk: 4, level: "L4", owner_key: true, owner_step_up: true } });
    expect(chk.json.check.satisfied).toBe(false);

    const cap = await call(ck, "/api/army/capabilities", { method: "POST", body: { agent_id: "x1", tools: ["think"], max_tier: 0 } });
    expect(cap.status).toBe(201);
    const dry = await call(ck, "/api/army/capabilities/check", { method: "POST", body: { token: cap.json.token, action: { tool_id: "email.send", tier: 4 } } });
    expect(dry.json).toMatchObject({ ok: false, reason: "tool_not_allowed" });
    const spend = await call(ck, "/api/army/capabilities", { method: "POST", body: { agent_id: "x1", tools: ["spend.request"], max_tier: 4, spend_cap_usd: 1 } });
    expect(spend.status).toBe(428);
    expect((await call(ck, `/api/army/capabilities/${cap.json.capability.token_id}/revoke`, { method: "POST", body: { reason: "t" } })).json.revoked).toBe(1);

    expect((await call(ck, "/api/army/passports", { method: "POST", body: { agent_id: "ghost" } })).status).toBe(404);

    const bad = await call(ck, "/api/army/missions", { method: "POST", body: { goal: "no rollback" } });
    expect(bad.status).toBe(400);
    const created = await call(ck, "/api/army/missions", { method: "POST", body: mission() });
    expect(created.status).toBe(201);
    const id = created.json.mission.id;
    expect((await call(ck, `/api/army/missions/${id}/start`, { method: "POST" })).status).toBe(409); // still draft
    const ap = await call(ck, `/api/army/missions/${id}/approve`, { method: "POST", body: {} });
    expect(ap.json.mission.status).toBe("approved");
    const st = await call(ck, `/api/army/missions/${id}/start`, { method: "POST" });
    expect(st.status).toBe(202);
    await drainJob(E, st.json.job_id);
    const got = await call(ck, `/api/army/missions/${id}`);
    expect(got.json.mission.status).toBe("done");
    expect((await call(ck, "/api/army/missions?status=done")).json.missions.length).toBe(1);

    const two = await call(ck, "/api/army/missions", { method: "POST", body: { goal: "publish the page", action_class: "publish", risk_tier: 4, autonomy_level: "L4", rollback_plan: ["unpublish"] } });
    const ap2 = await call(ck, `/api/army/missions/${two.json.mission.id}/approve`, { method: "POST", body: { keys: [{ approver: "security_council", by: "sec-1" }] } });
    expect(ap2.status).toBe(428); // needs TOTP step-up
    const badCode = await call(ck, `/api/army/missions/${two.json.mission.id}/approve`, { method: "POST", body: { code: "000000" } });
    expect([401, 423]).toContain(badCode.status);

    const v = await call(ck, "/api/army/audit/verify");
    expect(v.json.ok).toBe(true);
    expect(v.json.checked).toBeGreaterThan(5);
  });
});
