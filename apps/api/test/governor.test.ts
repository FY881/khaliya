import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CONSTITUTION } from "../src/constitution";
import { Governor, GovernorError } from "../src/governor/governor";
import { deriveCaps, FREE_TIER, GEMINI_FREE_RPD } from "../src/governor/quotas";
import { Registry } from "../src/registry/registry";
import { seedStarterOrg, starterGenome, STARTER_ORG } from "../src/registry/seed";
import { freshState } from "./helpers";

beforeEach(freshState);

describe("quota-derived caps (70% margin)", () => {
  it("provider caps are 70% of free RPD × keys", () => {
    const c = deriveCaps({ margin: 0.7, geminiKeys: 2, openrouterKeys: 1, workersAi: true });
    // Gemini is the sum of its per-model daily caps (each 70% of that model's free RPD × keys)
    expect(c.provider.gemini).toBe(Object.values(GEMINI_FREE_RPD).reduce((a, rpd) => a + Math.floor(rpd * 2 * 0.7), 0));
    expect(c.provider.openrouter).toBe(Math.floor(FREE_TIER.providers.openrouter.rpd * 0.7));
    expect(c.provider["workers-ai"]).toBe(Math.floor(FREE_TIER.providers["workers-ai"].rpd * 0.7));
    expect(c.global.llm_calls).toBe(c.provider.gemini + c.provider.openrouter + c.provider["workers-ai"]);
    expect(c.per_agent.llm_calls).toBe(Math.floor(c.global.llm_calls * 0.25));
    // runs are bounded by 70% of D1's free daily writes
    expect(c.global.runs).toBeLessThanOrEqual(Math.floor((FREE_TIER.d1_rows_written_day * 0.7) / 40));
  });

  it("margin is clamped to at most 90% and the constitution default is 70%", () => {
    expect(deriveCaps({ margin: 5 }).margin).toBe(0.9);
    expect(CONSTITUTION.quotaMargin).toBe(0.7);
    expect(Object.isFrozen(CONSTITUTION)).toBe(true);
    expect(Object.isFrozen(CONSTITUTION.runHardCaps)).toBe(true);
  });
});

describe("budget ledger", () => {
  it("debits atomically and refuses past the cap", async () => {
    const g = new Governor(env);
    expect(await g.debitOne("global", "x", 3, 5)).toBe(true);
    expect(await g.debitOne("global", "x", 2, 5)).toBe(true);
    expect(await g.debitOne("global", "x", 1, 5)).toBe(false);
    const u = (await g.usage()).find((r) => r.scope === "global" && r.metric === "x");
    expect(u?.used).toBe(5);
  });

  it("per-agent cap blocks one agent without touching the others", async () => {
    const g = new Governor(env);
    const caps = await g.caps();
    const cap = caps.per_agent.tool_calls;
    expect((await g.debit("a1", "tool_calls", cap)).ok).toBe(true);
    const r = await g.debit("a1", "tool_calls", 1);
    expect(r).toEqual({ ok: false, scope: "agent:a1" });
    expect((await g.debit("a2", "tool_calls", 1)).ok).toBe(true);
    // failed debit was refunded from global
    const global = (await g.usage()).find((x) => x.scope === "global" && x.metric === "tool_calls");
    expect(global?.used).toBe(cap + 1);
  });
});

describe("kill switches", () => {
  it("global kill stops everyone; agent kill stops only that agent", async () => {
    const g = new Governor(env);
    await g.setKill({ agent: "a_builder" }, true);
    await expect(g.assertMayContinue("a_builder")).rejects.toBeInstanceOf(GovernorError);
    await expect(g.assertMayContinue("a_critic")).resolves.toBeUndefined();
    await g.setKill("global", true);
    await expect(g.assertMayContinue("a_critic")).rejects.toThrow(/global/);
    await g.setKill("global", false);
    await g.setKill({ agent: "a_builder" }, false);
    await expect(g.assertMayContinue("a_builder")).resolves.toBeUndefined();
    expect(await g.killedAgents()).toEqual([]);
  });
});

describe("population cap", () => {
  it("refuses new agents beyond the cap", async () => {
    const g = new Governor(env);
    await g.setOverrides({ population_live: 8 });
    const res = await seedStarterOrg(env);
    expect(res.created.length).toBe(8);
    const reg = new Registry(env);
    const extra = await reg.putGenome({ ...starterGenome(STARTER_ORG[3]), lineage_id: "builder-2", name: "Builder 2" }, "owner");
    await expect(reg.createAgent(extra, { actor: "owner", status: "draft" })).rejects.toThrow(/population cap/);
  });
});
