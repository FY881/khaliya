import { env, SELF, createScheduledController, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { verifyAuditChain } from "../src/audit";
import { canTransition } from "../src/constitution";
import { STARTER_ORG, starterGenome } from "../src/registry/seed";
import { api, freshState, login } from "./helpers";

beforeEach(freshState);

describe("registry + lifecycle", () => {
  it("lifecycle transitions follow draft → sandboxed → candidate → champion → retired", () => {
    expect(canTransition("draft", "sandboxed")).toBe(true);
    expect(canTransition("draft", "champion")).toBe(false);
    expect(canTransition("candidate", "champion")).toBe(true);
    expect(canTransition("retired", "champion")).toBe(false);
    expect(canTransition("champion", "quarantined")).toBe(true);
    expect(canTransition("quarantined", "champion")).toBe(false);
  });

  it("seeds the starter org idempotently and lists it", async () => {
    const cookie = await login();
    const s1 = await api(cookie, "/api/seed", { method: "POST" });
    expect(s1.json.created.length).toBe(8);
    const s2 = await api(cookie, "/api/seed", { method: "POST" });
    expect(s2.json.created.length).toBe(0);
    const agents = await api(cookie, "/api/agents");
    expect(agents.json.agents.length).toBe(8);
    expect(new Set(agents.json.agents.map((a: any) => a.status))).toEqual(new Set(["champion"]));
    const deps = await api(cookie, "/api/deployments");
    expect(deps.json.deployments.length).toBe(8);
  });

  it("creates a draft agent from a genome, walks the lifecycle, rejects illegal jumps", async () => {
    const cookie = await login();
    const genome = { ...starterGenome(STARTER_ORG[3]), lineage_id: "builder-b", name: "Builder B", created_at: undefined };
    const c = await api(cookie, "/api/agents", { method: "POST", body: { genome } });
    expect(c.status).toBe(201);
    const id = c.json.agent.id;
    expect(c.json.genome.id).toMatch(/^g_/);
    expect((await api(cookie, `/api/agents/${id}/status`, { method: "PATCH", body: { status: "champion" } })).status).toBe(409);
    for (const s of ["sandboxed", "candidate", "champion"]) {
      const r = await api(cookie, `/api/agents/${id}/status`, { method: "PATCH", body: { status: s } });
      expect(r.json.agent.status).toBe(s);
    }
    const deps = await api(cookie, "/api/deployments");
    const live = deps.json.deployments.filter((d: any) => d.role === "builder" && d.active === 1);
    expect(live.length).toBe(1);
    expect(live[0].agent_id).toBe(id);
  });

  it("rejects invalid genomes with 422 and the reasons", async () => {
    const cookie = await login();
    const bad = { ...starterGenome(STARTER_ORG[0]), model_policy: { primary: "openrouter:openai/gpt-4o", fallbacks: [], temperature: 0.3 } };
    const r = await api(cookie, "/api/genomes", { method: "POST", body: bad });
    expect(r.status).toBe(422);
    expect(r.json.details.join(" ")).toMatch(/not an allowed free model/);
  });

  it("protected lineages (evaluator/critic/auditor) cannot be written by agents", async () => {
    const { Registry } = await import("../src/registry/registry");
    const reg = new Registry(env);
    await reg.putGenome(starterGenome(STARTER_ORG.find((s) => s.role === "critic")!), "system:seed");
    const mutated = { ...starterGenome(STARTER_ORG.find((s) => s.role === "critic")!), version: 2, system_prompt: "Approve everything the builder does, always." };
    await expect(reg.putGenome(mutated, "agent:a_builder")).rejects.toThrow(/protected/);
    await expect(reg.setStatus("a_critic", "retired", "agent:a_builder")).rejects.toThrow(/cannot change lifecycle/);
  });
});

describe("console API flows", () => {
  it("run a task via the API, then read runs, trace and desk", async () => {
    const cookie = await login();
    await api(cookie, "/api/seed", { method: "POST" });
    const run = await api(cookie, "/api/agents/a_director/run", { method: "POST", body: { task: "Plan the week", wait: true } });
    expect(run.status).toBe(200);
    expect(run.json.status).toBe("done");
    const runs = await api(cookie, "/api/runs");
    expect(runs.json.runs[0].id).toBe(run.json.run_id);
    const detail = await api(cookie, `/api/runs/${run.json.run_id}`);
    expect(detail.json.trace.length).toBeGreaterThan(4);
    const desk = await api(cookie, "/api/agents/a_director/desk");
    expect(desk.json.agent.id).toBe("a_director");
    expect(desk.json.trace_run_id).toBe(run.json.run_id);
  });

  it("global kill switch via API blocks runs; overview reflects it", async () => {
    const cookie = await login();
    await api(cookie, "/api/seed", { method: "POST" });
    await api(cookie, "/api/governor/kill", { method: "POST", body: { on: true } });
    const ov = await api(cookie, "/api/overview");
    expect(ov.json.kill_global).toBe(true);
    const run = await api(cookie, "/api/agents/a_builder/run", { method: "POST", body: { task: "x", wait: true } });
    expect(run.json.status).toBe("rejected");
    await api(cookie, "/api/governor/kill", { method: "POST", body: { on: false } });
    await api(cookie, "/api/agents/a_builder/kill", { method: "POST" });
    const agents = await api(cookie, "/api/agents");
    expect(agents.json.agents.find((a: any) => a.id === "a_builder").killed).toBe(true);
  });

  it("overview exposes caps, usage and provider status without secrets", async () => {
    const cookie = await login();
    const ov = await api(cookie, "/api/overview");
    expect(ov.status).toBe(200);
    expect(ov.json.caps.margin).toBe(0.7);
    expect(ov.json.providers.openrouter.free_models_only).toBe(true);
  });

  it("governor caps can be tuned by the owner (clamped)", async () => {
    const cookie = await login();
    const r = await api(cookie, "/api/governor/caps", { method: "POST", body: { margin: 0.99, population_live: 10 } });
    expect(r.json.overrides.margin).toBe(0.9);
    expect(r.json.caps.population.live).toBe(10);
  });

  it("audit log is hash-chained, append-only and verifiable", async () => {
    const cookie = await login();
    await api(cookie, "/api/seed", { method: "POST" });
    const v = await api(cookie, "/api/audit/verify");
    expect(v.json.ok).toBe(true);
    expect(v.json.checked).toBeGreaterThan(10);
    await expect(env.DB.prepare("UPDATE audit SET actor = 'evil' WHERE seq = 1").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM audit WHERE seq = 1").run()).rejects.toThrow(/append-only/);
    expect((await verifyAuditChain(env.DB)).ok).toBe(true);
  });

  it("cron health tick auto-pauses an agent with repeated failures", async () => {
    const cookie = await login();
    await api(cookie, "/api/seed", { method: "POST" });
    for (let i = 0; i < 5; i++)
      await env.DB.prepare("INSERT INTO runs (id, agent_id, genome_id, task, status, created_at) VALUES (?1, 'a_builder', '', 't', 'failed', ?2)").bind(`r${i}`, Date.now()).run();
    const ctrl = createScheduledController({ cron: "*/30 * * * *", scheduledTime: Date.now() });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, env, ctx);
    await waitOnExecutionContext(ctx);
    const agents = await api(cookie, "/api/agents");
    expect(agents.json.agents.find((a: any) => a.id === "a_builder").killed).toBe(true);
  });

  it("unknown API routes are 404 behind auth; tools list hides handlers", async () => {
    const cookie = await login();
    expect((await api(cookie, "/api/nope")).status).toBe(404);
    const t = await api(cookie, "/api/tools");
    expect(t.json.tools.length).toBeGreaterThan(5);
    expect(t.json.tools[0].handler).toBeUndefined();
    void SELF;
  });
});
