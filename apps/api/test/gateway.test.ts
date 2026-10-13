import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit";
import { Governor, GovernorError } from "../src/governor/governor";
import { seedStarterOrg } from "../src/registry/seed";
import type { MemoryStore } from "../src/tools/catalog";
import { ToolGateway } from "../src/tools/gateway";
import { freshState } from "./helpers";

beforeEach(async () => {
  await freshState();
  await seedStarterOrg(env);
});

function memStore(): MemoryStore & { items: string[] } {
  const items: string[] = [];
  return {
    items,
    write: async (_k, text) => {
      items.push(text);
      return { id: items.length };
    },
    search: async () => [],
  };
}

const gw = (o: Partial<ConstructorParameters<typeof ToolGateway>[0]> = {}) =>
  new ToolGateway({ env, agentId: "a_builder", role: "builder", runId: "run_t", sandboxed: false, genomeToolIds: ["think", "memory.write", "sandbox.eval"], memory: memStore(), ...o });

describe("tool gateway permissions", () => {
  it("allows a granted T0 tool, debits budget, writes audit", async () => {
    const mem = memStore();
    const r = await gw({ memory: mem }).call("memory.write", { text: "hello" });
    expect(r.status).toBe("ok");
    expect(mem.items).toEqual(["hello"]);
    const usage = await new Governor(env).usage();
    expect(usage.find((u) => u.scope === "agent:a_builder" && u.metric === "tool_calls")?.used).toBe(1);
    const log = await listAudit(env.DB, 5);
    expect(log[0].action).toBe("tool.call");
    expect(log[0].actor).toBe("agent:a_builder");
  });

  it("denies tools not in the genome", async () => {
    const r = await gw().call("org.message", { to: "a_critic", text: "hi" });
    expect(r).toMatchObject({ status: "denied", reason: "not_in_genome" });
    expect((await listAudit(env.DB, 1))[0].action).toBe("tool.denied");
  });

  it("denies tools above the role's tier ceiling even if the genome lists them", async () => {
    // critic's ceiling is T1; sandbox.eval is T2
    const r = await gw({ agentId: "a_critic", role: "critic", genomeToolIds: ["sandbox.eval"] }).call("sandbox.eval", { expression: "1+1" });
    expect(r.status).toBe("denied");
    expect((r as any).reason).toMatch(/tier_exceeds_role/);
  });

  it("denies unknown and forbidden tools, and missing args", async () => {
    expect((await gw().call("governor.set_caps", {})).status).toBe("denied");
    expect((await gw().call("nope", {})).status).toBe("denied");
    expect(await gw().call("memory.write", {})).toMatchObject({ status: "denied", reason: "missing_arg:text" });
  });

  it("T2 sandbox tool executes safely and rejects code injection", async () => {
    expect(await gw().call("sandbox.eval", { expression: "(2+3)*4" })).toMatchObject({ status: "ok", result: { value: 20 } });
    const bad = await gw().call("sandbox.eval", { expression: "globalThis.fetch('x')" });
    expect(bad.status).toBe("error");
  });

  it("T3 tools go to the approval queue instead of executing", async () => {
    const r = await gw({ agentId: "a_researcher", role: "researcher", genomeToolIds: ["http.get"] }).call("http.get", { url: "https://example.com" });
    expect(r.status).toBe("pending_approval");
    const row = await env.DB.prepare("SELECT * FROM approvals WHERE id = ?1").bind((r as any).approval_id).first<any>();
    expect(row.status).toBe("pending");
    expect(row.tier).toBe(3);
  });

  it("sandboxed agents get simulated results for external tiers (no approval, no effect)", async () => {
    const r = await gw({ agentId: "a_researcher", role: "researcher", genomeToolIds: ["http.get"], sandboxed: true }).call("http.get", { url: "https://example.com" });
    expect(r.status).toBe("sandboxed");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("kill switch blocks the gateway", async () => {
    await new Governor(env).setKill({ agent: "a_builder" }, true);
    await expect(gw().call("think", { note: "x" })).rejects.toBeInstanceOf(GovernorError);
  });

  it("budget exhaustion denies further tool calls", async () => {
    const g = new Governor(env);
    const caps = await g.caps();
    await g.debit("a_builder", "tool_calls", caps.per_agent.tool_calls);
    expect(await gw().call("think", { note: "x" })).toMatchObject({ status: "denied" });
  });
});
