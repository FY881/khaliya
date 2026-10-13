import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { finalizeGenome } from "../src/genome/schema";
import { Governor, GovernorError } from "../src/governor/governor";
import { home } from "../src/home/stub";
import { defaultMockScript, mockProvider } from "../src/llm/providers";
import type { LlmRequest, LlmResponse } from "../src/llm/types";
import { resolveCaps, runAgentLoop, type LoopDeps } from "../src/runtime/loop";
import { seedStarterOrg, starterGenome, STARTER_ORG } from "../src/registry/seed";
import type { MemoryStore } from "../src/tools/catalog";
import type { GatewayResult } from "../src/tools/gateway";
import { freshState } from "./helpers";

beforeEach(freshState);

function memory(): MemoryStore & { rows: { kind: string; text: string }[] } {
  const rows: { kind: string; text: string }[] = [];
  return {
    rows,
    write: async (kind, text) => {
      rows.push({ kind, text });
      return { id: rows.length };
    },
    search: async (q) => rows.filter((r) => r.text.toLowerCase().includes(q.toLowerCase().split(" ")[0])).map((r, i) => ({ id: i, kind: r.kind, text: r.text, score: 1, at: 0 })),
  };
}

async function deps(over: Partial<LoopDeps> = {}, script = defaultMockScript): Promise<LoopDeps> {
  const genome = await finalizeGenome(starterGenome(STARTER_ORG.find((s) => s.role === "builder")!));
  const mock = mockProvider(script);
  const mem = memory();
  const calls: string[] = [];
  return {
    genome,
    agentId: "a_builder",
    runId: "run_test",
    task: "Add 2 and 2",
    llm: { complete: (req: LlmRequest): Promise<LlmResponse> => mock.call({ model: "default", req, fetcher: fetch }) },
    gateway: {
      call: async (tool, args): Promise<GatewayResult> => {
        calls.push(tool);
        if (tool === "memory.write") await mem.write("note", String(args.text));
        return { status: "ok", tool, tier: 0, result: { ok: true } };
      },
    },
    memory: mem,
    governor: { assertMayContinue: async () => {} },
    caps: resolveCaps(genome),
    ...over,
  };
}

describe("runtime loop with mock LLM", () => {
  it("runs perceive → retrieve → plan → act → reflect → memory and finishes", async () => {
    const d = await deps();
    const r = await runAgentLoop(d);
    expect(r.status).toBe("done");
    expect(r.final).toBe("Mock answer for: Add 2 and 2");
    expect(r.plan.length).toBe(3);
    expect(r.tool_calls).toBe(1);
    expect(r.steps).toBe(2);
    expect(r.llm_calls).toBe(4); // plan + 2 act + reflect
    expect(r.lessons.length).toBe(1);
    const phases = r.trace.map((t) => t.phase);
    expect(phases.slice(0, 3)).toEqual(["perceive", "retrieve", "plan"]);
    expect(phases).toContain("observe");
    expect(phases.slice(-2)).toEqual(["reflect", "memory"]);
    const mem = d.memory as ReturnType<typeof memory>;
    expect(mem.rows.map((x) => x.kind)).toEqual(["note", "episode", "lesson"]);
    expect(r.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("step cap stops a looping agent", async () => {
    const d = await deps({ task: "MOCK:loop forever" });
    d.caps = { ...d.caps, max_steps: 3, max_tool_calls: 99, max_llm_calls: 99 };
    const r = await runAgentLoop(d);
    expect(r.status).toBe("capped");
    expect(r.stop_reason).toBe("max_steps");
    expect(r.steps).toBe(3);
  });

  it("tool-call cap stops tool spam", async () => {
    const d = await deps({ task: "MOCK:loop" });
    d.caps = { ...d.caps, max_steps: 12, max_tool_calls: 2, max_llm_calls: 99 };
    const r = await runAgentLoop(d);
    expect(r.stop_reason).toBe("max_tool_calls");
    expect(r.tool_calls).toBe(2);
  });

  it("token cap stops a verbose model", async () => {
    const d = await deps({}, () => JSON.stringify({ thought: "x".repeat(8000), action: { tool: "think", args: { note: "n" } } }));
    d.caps = { ...d.caps, max_tokens: 3000, max_steps: 12, max_tool_calls: 99, max_llm_calls: 99 };
    const r = await runAgentLoop(d);
    expect(r.status).toBe("capped");
    expect(r.stop_reason).toBe("max_tokens");
  });

  it("llm-call cap", async () => {
    const d = await deps({ task: "MOCK:loop" });
    d.caps = { ...d.caps, max_llm_calls: 2, max_steps: 12, max_tool_calls: 99 };
    const r = await runAgentLoop(d);
    expect(r.stop_reason).toBe("max_llm_calls");
    expect(r.llm_calls).toBe(2);
  });

  it("wall-time cap (injected clock)", async () => {
    let t = 0;
    const d = await deps({ task: "MOCK:loop", clock: () => (t += 1000) });
    d.caps = { ...d.caps, max_wall_ms: 5000, max_steps: 12, max_tool_calls: 99, max_llm_calls: 99 };
    const r = await runAgentLoop(d);
    expect(r.stop_reason).toBe("max_wall_ms");
  });

  it("wall-time cap interrupts a hanging LLM call", async () => {
    const d = await deps({ llm: { complete: () => new Promise<LlmResponse>(() => {}) } });
    d.caps = { ...d.caps, max_wall_ms: 50 };
    const r = await runAgentLoop(d);
    expect(r.status).toBe("capped");
    expect(r.stop_reason).toBe("max_wall_ms");
  });

  it("kill switch mid-run stops immediately and skips reflection", async () => {
    let n = 0;
    const d = await deps({
      task: "MOCK:loop",
      governor: {
        assertMayContinue: async () => {
          if (++n > 3) throw new GovernorError("killed", "kill switch (global) is ON");
        },
      },
    });
    const r = await runAgentLoop(d);
    expect(r.status).toBe("killed");
    expect(r.trace.some((t) => t.phase === "reflect")).toBe(false);
    expect(r.trace.at(-1)?.phase).toBe("memory");
  });

  it("genome budget can lower but never raise the constitutional caps", async () => {
    const c = resolveCaps({ budget_profile: { max_steps: 3, max_tokens: 10_000_000 } as any });
    expect(c.max_steps).toBe(3);
    expect(c.max_tokens).toBe(24000);
  });
});

describe("AgentHome Durable Object (end-to-end with mock provider)", () => {
  it("runs a task, persists trace + memory in the home, records the run in D1", async () => {
    await seedStarterOrg(env);
    const h = home(env, "a_builder");
    const r = await h.runTask("a_builder", "Compute 6*7 and remember it");
    expect(r.status).toBe("done");
    expect(r.final).toContain("Compute 6*7");
    const desk = await h.desk("a_builder");
    expect(desk.trace.length).toBeGreaterThan(5);
    expect(desk.memory.some((m: any) => m.kind === "episode")).toBe(true);
    expect(desk.memory.some((m: any) => m.text.startsWith("Task noted"))).toBe(true);
    expect(desk.tools.map((t: any) => t.id)).toContain("sandbox.eval");
    const row = await env.DB.prepare("SELECT * FROM runs WHERE id = ?1").bind(r.run_id).first<any>();
    expect(row.status).toBe("done");
    expect(row.llm_calls).toBe(4);
    const usage = await new Governor(env).usage();
    expect(usage.find((u) => u.scope === "agent:a_builder" && u.metric === "llm_calls")?.used).toBe(4);
    expect(usage.find((u) => u.scope === "provider:mock" && u.metric === "llm_calls")?.used).toBe(4);
  });

  it("memory from earlier runs is retrieved in later runs", async () => {
    await seedStarterOrg(env);
    const h = home(env, "a_builder");
    await h.runTask("a_builder", "Remember the codeword falcon");
    await h.runTask("a_builder", "What was the codeword falcon about?");
    const desk = await h.desk("a_builder");
    const retrieve = desk.trace.find((t: any) => t.phase === "retrieve");
    expect(retrieve.summary).not.toMatch(/^0 memory/);
  });

  it("a researcher's external read lands in the approval queue", async () => {
    await seedStarterOrg(env);
    const r = await home(env, "a_researcher").runTask("a_researcher", "MOCK:approval read example.com");
    expect(r.status).toBe("done");
    const ap = await env.DB.prepare("SELECT * FROM approvals WHERE agent_id = 'a_researcher'").first<any>();
    expect(ap.tool_id).toBe("http.get");
    expect(ap.status).toBe("pending");
  });

  it("rejects runs when killed, retired or over budget", async () => {
    await seedStarterOrg(env);
    const gov = new Governor(env);
    await gov.setKill("global", true);
    expect((await home(env, "a_critic").runTask("a_critic", "x")).status).toBe("rejected");
    await gov.setKill("global", false);
    await env.DB.prepare("UPDATE agents SET status = 'retired' WHERE id = 'a_critic'").run();
    expect((await home(env, "a_critic").runTask("a_critic", "x")).stop_reason).toMatch(/cannot run/);
    const caps = await gov.caps();
    await gov.debit("a_builder", "runs", caps.per_agent.runs);
    expect((await home(env, "a_builder").runTask("a_builder", "x")).stop_reason).toMatch(/runs cap/);
  });

  it("enqueue + alarm executes the queued task", async () => {
    await seedStarterOrg(env);
    const { runDurableObjectAlarm } = await import("cloudflare:test");
    const stub = env.AGENT_HOME.get(env.AGENT_HOME.idFromName("a_librarian"));
    const runId = await (stub as any).enqueue("a_librarian", "Summarize today");
    // The alarm is scheduled ~10 ms out; it may already have fired on its own. Either way the run must finish.
    await runDurableObjectAlarm(stub);
    let status = "";
    for (let i = 0; i < 50 && status !== "done"; i++) {
      status = (await env.DB.prepare("SELECT status FROM runs WHERE id = ?1").bind(runId).first<any>())?.status ?? "";
      if (status !== "done") await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("done");
  });
});
