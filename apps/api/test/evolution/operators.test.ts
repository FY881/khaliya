import { describe, expect, it } from "vitest";
import { CONSTITUTION } from "../../src/constitution";
import { finalizeGenome, isFreeModel, validateGenome, verifyGenomeId, type Genome, type GenomeInput } from "../../src/genome/schema";
import { STARTER_ORG, starterGenome } from "../../src/registry/seed";
import { mulberry32 } from "../../src/evolution/bandit";
import {
  addableTools,
  crossover,
  distill,
  FREE_MODEL_POOL,
  LEARNED_HEADER,
  lineageSlug,
  model_policy_change,
  OperatorError,
  OPERATORS,
  prompt_rewrite,
  spawn_role,
  splitLearned,
  strategy_swap,
  tool_add,
  tool_remove,
  toolAllowedForRole,
} from "../../src/evolution/operators";

const AT = 1_700_000_000_000;
const ctx = { at: AT, by: "agent:architect-1" };
const seedOf = (role: string): GenomeInput => starterGenome(STARTER_ORG.find((s) => s.role === role)!);
const make = (role: string, over: Partial<GenomeInput> = {}) => finalizeGenome({ ...seedOf(role), ...over }, 1);

async function expectChild(child: Genome, parent: Genome, op: string) {
  expect(validateGenome(child).ok).toBe(true);
  expect(await verifyGenomeId(child)).toBe(true);
  expect(child.id).not.toBe(parent.id);
  expect(child.version).toBe(parent.version + 1);
  expect(child.parent_ids).toEqual([parent.id]);
  expect(child.lineage_id).toBe(parent.lineage_id);
  expect(child.created_at).toBe(AT);
  expect(child.created_by).toBe(ctx.by);
  const last = child.mutation_log.at(-1)!;
  expect(last.op).toBe(op);
  expect(last.at).toBe(AT);
  expect(last.by).toBe(ctx.by);
  expect(typeof last.note).toBe("string");
  expect(child.mutation_log.length).toBe(parent.mutation_log.length + 1);
}

describe("OPERATORS", () => {
  it("lists unique operator ids for the bandit", () => {
    expect(OPERATORS).toEqual([
      "prompt_rewrite",
      "strategy_swap",
      "tool_add",
      "tool_remove",
      "model_policy_change",
      "crossover",
      "distill",
      "spawn_role",
    ]);
    expect(new Set(OPERATORS).size).toBe(OPERATORS.length);
  });
  it("free model pool is non-empty, free and mock-free", () => {
    expect(FREE_MODEL_POOL.length).toBeGreaterThan(1);
    for (const m of FREE_MODEL_POOL) {
      expect(isFreeModel(m)).toBe(true);
      expect(m.startsWith("mock:")).toBe(false);
    }
  });
});

describe("prompt_rewrite", () => {
  it("produces a valid child with the new prompt", async () => {
    const p = await make("builder");
    const c = await prompt_rewrite(p, "You are the Builder. Write small, tested increments and explain each change.", ctx);
    await expectChild(c, p, "prompt_rewrite");
    expect(c.system_prompt).toMatch(/small, tested increments/);
    expect(p.system_prompt).not.toMatch(/small, tested/); // parent untouched
  });
  it("is deterministic for a fixed ctx.at", async () => {
    const p = await make("builder");
    const a = await prompt_rewrite(p, "A completely different prompt text.", ctx);
    const b = await prompt_rewrite(p, "A completely different prompt text.", ctx);
    expect(a).toEqual(b);
  });
  it("rejects unchanged, too short and too long prompts", async () => {
    const p = await make("builder");
    await expect(prompt_rewrite(p, p.system_prompt, ctx)).rejects.toThrow(OperatorError);
    await expect(prompt_rewrite(p, "short", ctx)).rejects.toThrow(/too short/);
    await expect(prompt_rewrite(p, "x".repeat(CONSTITUTION.genomeLimits.system_prompt_chars + 1), ctx)).rejects.toThrow(/exceeds/);
  });
});

describe("strategy_swap", () => {
  it("always picks a different strategy, deterministically per seed", async () => {
    const p = await make("builder");
    for (let s = 0; s < 20; s++) {
      const c = await strategy_swap(p, mulberry32(s), ctx);
      expect(c.planning_strategy).not.toBe(p.planning_strategy);
      await expectChild(c, p, "strategy_swap");
    }
    const a = await strategy_swap(p, mulberry32(42), ctx);
    const b = await strategy_swap(p, mulberry32(42), ctx);
    expect(a.id).toBe(b.id);
  });
  it("covers all alternatives across seeds", async () => {
    const p = await make("builder");
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) seen.add((await strategy_swap(p, mulberry32(s), ctx)).planning_strategy);
    expect(seen.size).toBe(3);
  });
});

describe("tool_add / tool_remove", () => {
  it("adds an allowed tool", async () => {
    const p = await make("builder", { tool_ids: ["think", "memory.write"] });
    const c = await tool_add(p, "sandbox.eval", ctx);
    await expectChild(c, p, "tool_add");
    expect(c.tool_ids).toContain("sandbox.eval");
  });
  it("respects the role tier ceiling", async () => {
    const builder = await make("builder");
    await expect(tool_add(builder, "http.get", ctx)).rejects.toThrow(/above builder ceiling T2/);
    const critic = await make("critic");
    await expect(tool_add(critic, "sandbox.eval", ctx)).rejects.toThrow(/ceiling T1/);
    const director = await make("director");
    const c = await tool_add(director, "email.send", ctx);
    expect(c.tool_ids).toContain("email.send");
  });
  it("refuses forbidden prefixes, unknown tools and duplicates", async () => {
    const p = await make("builder");
    await expect(tool_add(p, "governor.override", ctx)).rejects.toThrow(/forbidden/);
    await expect(tool_add(p, "constitution.edit", ctx)).rejects.toThrow(/forbidden/);
    await expect(tool_add(p, "made.up", ctx)).rejects.toThrow(/unknown tool/);
    await expect(tool_add(p, p.tool_ids[0]!, ctx)).rejects.toThrow(/already/);
  });
  it("removes a present tool and refuses absent/last tool", async () => {
    const p = await make("builder", { tool_ids: ["think", "memory.write"] });
    const c = await tool_remove(p, "memory.write", ctx);
    await expectChild(c, p, "tool_remove");
    expect(c.tool_ids).toEqual(["think"]);
    await expect(tool_remove(p, "sandbox.eval", ctx)).rejects.toThrow(/does not have/);
    await expect(tool_remove(c, "think", ctx)).rejects.toThrow(/last tool/);
  });
  it("addableTools / toolAllowedForRole agree with the ceiling", async () => {
    const p = await make("architect", { tool_ids: ["think"] });
    const add = addableTools(p);
    expect(add).toContain("org.message");
    expect(add).not.toContain("sandbox.eval");
    expect(add).not.toContain("think");
    expect(toolAllowedForRole("web.publish", "researcher").ok).toBe(false);
    expect(toolAllowedForRole("http.get", "researcher").ok).toBe(true);
  });
});

describe("model_policy_change", () => {
  it("only ever yields free models and changes the policy", async () => {
    const p = await make("builder");
    const kinds = new Set<string>();
    for (let s = 0; s < 60; s++) {
      const c = await model_policy_change(p, mulberry32(s), ctx);
      await expectChild(c, p, "model_policy_change");
      expect(c.model_policy).not.toEqual(p.model_policy);
      expect(isFreeModel(c.model_policy.primary)).toBe(true);
      for (const f of c.model_policy.fallbacks) expect(isFreeModel(f)).toBe(true);
      expect(c.model_policy.fallbacks).not.toContain(c.model_policy.primary);
      expect(c.model_policy.temperature).toBeGreaterThanOrEqual(0);
      expect(c.model_policy.temperature).toBeLessThanOrEqual(1.5);
      kinds.add(c.mutation_log.at(-1)!.note!.split(" ")[0]!);
    }
    expect(kinds).toEqual(new Set(["primary", "fallback", "temperature"]));
  });
  it("filters non-free models out of a custom pool", async () => {
    const p = await make("builder");
    const pool = ["openrouter:openai/gpt-4o", "anthropic:claude", "openrouter:qwen/qwen3:free"];
    for (let s = 0; s < 20; s++) {
      const c = await model_policy_change(p, mulberry32(s), ctx, pool);
      expect([p.model_policy.primary, "openrouter:qwen/qwen3:free"]).toContain(c.model_policy.primary);
    }
    await expect(model_policy_change(p, mulberry32(1), ctx, ["openrouter:openai/gpt-4o"])).rejects.toThrow(/no free models/);
  });
  it("is deterministic per seed", async () => {
    const p = await make("builder");
    expect((await model_policy_change(p, mulberry32(9), ctx)).id).toBe((await model_policy_change(p, mulberry32(9), ctx)).id);
  });
});

describe("crossover", () => {
  it("mixes fields from both parents, differs from both, lists both parents", async () => {
    const a = await make("builder", { planning_strategy: "react", tool_ids: ["think"], memory_policy: { working_k: 4, episodic_retention_days: 30, write_lessons: true } });
    const b = await make("builder", {
      system_prompt: "You are an alternative builder that prefers explicit plans and tiny diffs.",
      planning_strategy: "reflexion",
      tool_ids: ["think", "sandbox.eval"],
      memory_policy: { working_k: 10, episodic_retention_days: 60, write_lessons: false },
      version: 3,
    });
    for (let s = 0; s < 25; s++) {
      const c = await crossover(a, b, mulberry32(s), ctx);
      expect(validateGenome(c).ok).toBe(true);
      expect(await verifyGenomeId(c)).toBe(true);
      expect(c.parent_ids).toEqual([a.id, b.id]);
      expect(c.version).toBe(4);
      expect(c.lineage_id).toBe(a.lineage_id);
      expect(c.mutation_log.at(-1)!.op).toBe("crossover");
      const fields = ["system_prompt", "planning_strategy", "tool_ids", "memory_policy"] as const;
      const fromA = fields.filter((f) => JSON.stringify(c[f]) === JSON.stringify(a[f]));
      const fromB = fields.filter((f) => JSON.stringify(c[f]) === JSON.stringify(b[f]));
      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      expect(fromA.length + fromB.length).toBe(fields.length);
    }
  });
  it("with one differing field takes b's trait", async () => {
    const a = await make("builder", { planning_strategy: "react" });
    const b = await make("builder", { planning_strategy: "tree-of-thought" });
    const c = await crossover(a, b, mulberry32(3), ctx);
    expect(c.planning_strategy).toBe("tree-of-thought");
  });
  it("rejects role mismatch and identical parents", async () => {
    const a = await make("builder");
    const r = await make("researcher");
    await expect(crossover(a, r, mulberry32(1), ctx)).rejects.toThrow(/role mismatch/);
    await expect(crossover(a, a, mulberry32(1), ctx)).rejects.toThrow(/identical/);
    const a2 = await finalizeGenome({ ...seedOf("builder"), name: "Builder 2" }, 1);
    await expect(crossover(a, a2, mulberry32(1), ctx)).rejects.toThrow(/identical content/);
  });
  it("is deterministic per seed", async () => {
    const a = await make("builder", { planning_strategy: "react" });
    const b = await make("builder", { planning_strategy: "reflexion", tool_ids: ["think"] });
    expect((await crossover(a, b, mulberry32(77), ctx)).id).toBe((await crossover(a, b, mulberry32(77), ctx)).id);
  });
});

describe("distill", () => {
  it("appends a Learned practices section", async () => {
    const p = await make("builder");
    const c = await distill(p, ["Run the tests before reporting done.", "  - Prefer small diffs  "], ctx);
    await expectChild(c, p, "distill");
    expect(c.system_prompt).toContain(LEARNED_HEADER);
    expect(splitLearned(c.system_prompt).lessons).toEqual(["Run the tests before reporting done.", "Prefer small diffs"]);
    expect(splitLearned(c.system_prompt).body).toBe(p.system_prompt.trimEnd());
  });
  it("merges with an existing section and drops near-duplicates", async () => {
    const p = await make("builder");
    const c1 = await distill(p, ["Run the tests before reporting done."], ctx);
    const c2 = await distill(c1, ["run the tests before reporting done!", "Cite the file you changed."], ctx);
    expect(splitLearned(c2.system_prompt).lessons).toEqual(["Run the tests before reporting done.", "Cite the file you changed."]);
    expect(c2.system_prompt.split(LEARNED_HEADER).length).toBe(2);
    await expect(distill(c2, ["Cite the file you changed"], ctx)).rejects.toThrow(/no new lessons/);
  });
  it("bounds the section: keeps newest maxLessons, truncates long lessons", async () => {
    const p = await make("builder");
    const lessons = Array.from({ length: 12 }, (_, i) => `Lesson number ${i} about topic ${"abcdefghijkl"[i]}${i * 7919}.`);
    const c = await distill(p, lessons, ctx, { maxLessons: 5 });
    const got = splitLearned(c.system_prompt).lessons;
    expect(got).toHaveLength(5);
    expect(got[4]).toContain("Lesson number 11");
    const long = await distill(p, ["y".repeat(1000)], ctx);
    expect(splitLearned(long.system_prompt).lessons[0]!.length).toBe(240);
  });
  it("stays within the prompt char limit", async () => {
    const big = "B".repeat(CONSTITUTION.genomeLimits.system_prompt_chars - 300);
    const p = await make("builder", { system_prompt: big });
    const c = await distill(p, ["First practice is to be careful with inputs.", "Second practice: always verify outputs twice."], ctx);
    expect(c.system_prompt.length).toBeLessThanOrEqual(CONSTITUTION.genomeLimits.system_prompt_chars);
    const full = await make("builder", { system_prompt: "C".repeat(CONSTITUTION.genomeLimits.system_prompt_chars - 5) });
    await expect(distill(full, ["Some lesson that cannot fit."], ctx)).rejects.toThrow(/no room/);
  });
});

describe("spawn_role", () => {
  it("starts a new lineage at version 1", async () => {
    const t = await make("researcher");
    const c = await spawn_role(t, "Market Researcher", ctx);
    expect(validateGenome(c).ok).toBe(true);
    expect(await verifyGenomeId(c)).toBe(true);
    expect(c.lineage_id).toBe("market-researcher");
    expect(c.version).toBe(1);
    expect(c.parent_ids).toEqual([t.id]);
    expect(c.name).toBe("Market Researcher");
    expect(c.role).toBe("researcher");
    expect(c.system_prompt.startsWith("You are the Market Researcher.")).toBe(true);
    expect(c.mutation_log).toHaveLength(1);
    expect(c.mutation_log[0]!.op).toBe("spawn_role");
  });
  it("drops tools above the new role's ceiling", async () => {
    const t = await make("director", { tool_ids: ["think", "org.message", "email.send", "http.get"] });
    const c = await spawn_role(t, "Planner", ctx, { role: "architect" });
    expect(c.role).toBe("architect");
    expect(c.tool_ids).toEqual(["org.message", "think"]);
  });
  it("handles non-latin names and explicit options", async () => {
    const t = await make("builder");
    const c = await spawn_role(t, "المترجم", ctx);
    expect(c.lineage_id).toMatch(/^role-[0-9a-f]+$/);
    const d = await spawn_role(t, "QA", ctx, { lineageId: "qa-1", prompt: "You check builds for regressions and report them." });
    expect(d.lineage_id).toBe("qa-1");
    expect(d.system_prompt).toBe("You check builds for regressions and report them.");
    await expect(spawn_role(t, "Builder", ctx, { lineageId: t.lineage_id })).rejects.toThrow(/must differ/);
    await expect(spawn_role(t, "  ", ctx)).rejects.toThrow(/required/);
  });
  it("lineageSlug produces valid ids", () => {
    expect(lineageSlug("Data  Analyst!!")).toBe("data-analyst");
    expect(lineageSlug("x")).toMatch(/^role-/);
    expect(lineageSlug("A".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe("mutation log is bounded", () => {
  it("keeps at most the constitutional maximum entries", async () => {
    const log = Array.from({ length: CONSTITUTION.genomeLimits.mutation_log }, (_, i) => ({ op: "x", at: i }));
    const p = await make("builder", { mutation_log: log });
    const c = await strategy_swap(p, mulberry32(1), ctx);
    expect(c.mutation_log).toHaveLength(CONSTITUTION.genomeLimits.mutation_log);
    expect(c.mutation_log.at(-1)!.op).toBe("strategy_swap");
  });
});
