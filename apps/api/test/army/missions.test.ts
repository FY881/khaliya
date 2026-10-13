import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { approveMission, buildContract, canMissionTransition, createMission, getMission, MISSION_STATUSES, MISSION_TRANSITIONS, rollbackMission, transitionMission, mintMissionRoot } from "../../src/army/missions";
import { useCapability } from "../../src/army/capability";
import { seedStarterOrg } from "../../src/registry/seed";
import { freshState } from "../helpers";

const E = env as Env;
beforeEach(freshState);

const ROLLBACK = ["delete drafts created by the mission"];

describe("mission contract validation", () => {
  it("requires a goal and a rollback plan", () => {
    expect(() => buildContract({ goal: "write a summary" } as any)).toThrow(/rollback_plan/);
    expect(() => buildContract({ goal: "write a summary", rollback_plan: [] })).toThrow(/rollback_plan/);
    expect(() => buildContract({ goal: "", rollback_plan: ROLLBACK })).toThrow(/goal/);
    const c = buildContract({ goal: "write a summary", rollback_plan: "discard the summary" });
    expect(c.rollback_plan.steps).toEqual(["discard the summary"]);
    expect(c.success_criteria.length).toBeGreaterThan(0);
  });
  it("forbids core changes, enforces deadlines and verifier separation", () => {
    expect(() => buildContract({ goal: "edit the constitution", action_class: "core_change", risk_tier: 4, rollback_plan: ROLLBACK })).toThrow(/forbidden/);
    expect(() => buildContract({ goal: "late mission", deadline: Date.now() - 1, rollback_plan: ROLLBACK })).toThrow(/deadline/);
    expect(() => buildContract({ goal: "self check", assigned_swarm: { planner: "p", workers: ["w1"], verifier: "w1" }, rollback_plan: ROLLBACK })).toThrow(/verifier/);
  });
  it("L5 missions are capped at 7 days", () => {
    expect(() => buildContract({ goal: "long run", autonomy_level: "L5", deadline_hours: 24 * 8, rollback_plan: ROLLBACK })).toThrow(/7 days/);
    expect(buildContract({ goal: "short run", autonomy_level: "L5", deadline_hours: 24 * 6, rollback_plan: ROLLBACK }).autonomy_level).toBe("L5");
  });
});

describe("mission state machine", () => {
  it("transition table is closed and terminal states are final", () => {
    expect(canMissionTransition("draft", "approved")).toBe(true);
    expect(canMissionTransition("draft", "running")).toBe(false);
    expect(canMissionTransition("running", "done")).toBe(false); // only through verifying
    expect(canMissionTransition("verifying", "done")).toBe(true);
    expect(canMissionTransition("failed", "rolled_back")).toBe(true);
    expect(MISSION_TRANSITIONS.done.length + MISSION_TRANSITIONS.rolled_back.length).toBe(0);
    for (const s of MISSION_STATUSES) for (const t of MISSION_TRANSITIONS[s]) expect(MISSION_STATUSES).toContain(t);
  });

  it("draft → approved → running → verifying → done, rejecting illegal jumps", async () => {
    const m = await createMission(E, { goal: "summarise the KB", rollback_plan: ROLLBACK });
    expect(m.status).toBe("draft");
    await expect(transitionMission(E, m.id, "running", "owner")).rejects.toMatchObject({ code: "bad_transition" });
    await approveMission(E, m.id, { actor: "owner" });
    await expect(approveMission(E, m.id, { actor: "owner" })).rejects.toMatchObject({ code: "bad_transition" });
    await transitionMission(E, m.id, "running", "owner");
    await expect(transitionMission(E, m.id, "done", "owner")).rejects.toMatchObject({ code: "bad_transition" });
    await transitionMission(E, m.id, "verifying", "army.swarm");
    const done = await transitionMission(E, m.id, "done", "agent:verifier", { verdict: { pass: true } });
    expect(done.status).toBe("done");
    await expect(rollbackMission(E, m.id, "too late", "owner")).rejects.toMatchObject({ code: "bad_transition" });
  });

  it("only the owner approves", async () => {
    const m = await createMission(E, { goal: "summarise the KB", rollback_plan: ROLLBACK });
    await expect(approveMission(E, m.id, { actor: "agent:a_director" })).rejects.toMatchObject({ code: "not_owner" });
  });

  it("rollback: executes the plan, revokes mission capabilities and lands in rolled_back", async () => {
    const m = await createMission(E, { goal: "draft replies", rollback_plan: ["delete drafts", "notify owner"], scope: { tools: ["think"], max_tier: 0 } });
    await approveMission(E, m.id, { actor: "owner" });
    const running = await transitionMission(E, m.id, "running", "owner");
    const root = await mintMissionRoot(E, running);
    expect((await useCapability(E, root.token, { tool_id: "think", tier: 0 })).ok).toBe(true);
    const rb = await rollbackMission(E, m.id, "owner changed mind", "owner");
    expect(rb.status).toBe("rolled_back");
    expect((rb.rollback as any).steps.map((s: any) => s.status)).toEqual(["executed", "executed"]);
    expect((rb.rollback as any).capabilities_revoked).toBe(1);
    expect(await useCapability(E, root.token, { tool_id: "think", tier: 0 })).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("mission approvals: two-key, step-up, L5", () => {
  it("a two-key mission needs owner step-up + a second key", async () => {
    const m = await createMission(E, { goal: "send the launch email", action_class: "external_comms", risk_tier: 4, autonomy_level: "L4", rollback_plan: ["send a correction email"] });
    expect(m.contract.requirement.two_key).toBe(true);
    await expect(approveMission(E, m.id, { actor: "owner", stepUpOk: true })).rejects.toMatchObject({ code: "approvals_missing" });
    await expect(approveMission(E, m.id, { actor: "owner", keys: [{ approver: "court", by: "legal-1" }] })).rejects.toMatchObject({ code: "step_up_required" });
    const ok = await approveMission(E, m.id, { actor: "owner", stepUpOk: true, keys: [{ approver: "court", by: "legal-1", division: "legal" }] });
    expect(ok.status).toBe("approved");
    expect(ok.approvals.map((k) => k.approver)).toEqual(["owner", "court"]);
  });

  it("L5: owner + step-up, one live L5 mission per agent", async () => {
    const a = await createMission(E, { goal: "week-long ops", autonomy_level: "L5", deadline_hours: 48, assigned_swarm: { planner: "lead-1" }, rollback_plan: ROLLBACK });
    const b = await createMission(E, { goal: "second ops", autonomy_level: "L5", deadline_hours: 48, assigned_swarm: { planner: "lead-1" }, rollback_plan: ROLLBACK });
    await expect(createMission(E, { goal: "agent tries L5", autonomy_level: "L5", rollback_plan: ROLLBACK }, "agent:x")).rejects.toMatchObject({ code: "l5_rule" });
    await expect(approveMission(E, a.id, { actor: "owner" })).rejects.toMatchObject({ code: "step_up_required" });
    await approveMission(E, a.id, { actor: "owner", stepUpOk: true });
    await expect(approveMission(E, b.id, { actor: "owner", stepUpOk: true })).rejects.toMatchObject({ code: "l5_rule" });
    const g = await E.DB.prepare("SELECT expires_at FROM army_l5_grants WHERE mission_id = ?1").bind(a.id).first<{ expires_at: number }>();
    expect(g!.expires_at - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    // Rolling back A releases the L5 slot.
    await transitionMission(E, a.id, "running", "owner");
    await rollbackMission(E, a.id, "stop", "owner");
    expect((await approveMission(E, b.id, { actor: "owner", stepUpOk: true })).status).toBe("approved");
  });

  it("verifier must not share a lineage with the swarm (art. 6)", async () => {
    await seedStarterOrg(E, "owner");
    await expect(createMission(E, { goal: "self-verify", assigned_swarm: { planner: "a_director", workers: ["a_builder"], verifier: "a_builder" }, rollback_plan: ROLLBACK })).rejects.toMatchObject({ code: "verifier_conflict" });
    const lin = await E.DB.prepare("SELECT lineage_id FROM agents WHERE id = 'a_builder'").first<{ lineage_id: string }>();
    await E.DB.prepare("UPDATE agents SET lineage_id = ?1 WHERE id = 'a_evaluator'").bind(lin!.lineage_id).run();
    await expect(createMission(E, { goal: "same lineage", assigned_swarm: { planner: "a_director", workers: ["a_builder"], verifier: "a_evaluator" }, rollback_plan: ROLLBACK })).rejects.toMatchObject({ code: "verifier_conflict" });
    expect((await getMission(E, "nope"))).toBeNull();
  });
});
