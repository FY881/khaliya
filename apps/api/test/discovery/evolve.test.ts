import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { elitesOf, getProblemRow, listRecords, topPrograms } from "../../src/discovery/store";
import { DISCOVERY_FREE_PLAN, runGenerations, stepGeneration } from "../../src/discovery/evolve";
import type { Env } from "../../src/env";
import { LabLLM } from "../../src/eval/llm";
import { freshState } from "../helpers";

const E = env as unknown as Env;
beforeEach(freshState);

describe("program evolution (islands + MAP-Elites)", () => {
  it("Golomb-10: deterministic mutations alone improve the ruler over a few generations", async () => {
    const steps = await runGenerations(E, null, "golomb-10", 12, { children: 3, llm: "off", seed: "t1" });
    const first = steps[0];
    expect(first.children[0]).toMatchObject({ op: "seed", valid: true, score: 9841 });
    const best = steps[steps.length - 1].best!;
    expect(best).toBeLessThan(9841);
    expect(best).toBeGreaterThanOrEqual(55); // never below the proven optimum
    const recs = await listRecords(E, { problem_id: "golomb-10" });
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs.every((r) => r.status === "candidate" && r.vs_known === "below")).toBe(true);
    const row = (await getProblemRow(E, "golomb-10"))!;
    expect(row.generation).toBe(12);
    expect(JSON.parse(row.bandit!).arms).toHaveProperty("tweak");
    // islands each hold an archive; every elite occupies a distinct cell
    for (const island of [0, 1, 2]) {
      const el = await elitesOf(E, "golomb-10", island);
      expect(el.length).toBeGreaterThan(0);
      expect(new Set(el.map((e) => e.cell)).size).toBe(el.length);
    }
    console.log(`[discovery] golomb-10 best after 12 gens × 3 children: ${best} (seed 9841, optimum 55)`);
  });

  it("Sidon-100: deterministic mutations improve the set size", async () => {
    const steps = await runGenerations(E, null, "sidon-100", 15, { children: 3, llm: "off", seed: "t2" });
    const seedScore = steps[0].children[0].score!;
    const best = steps[steps.length - 1].best!;
    expect(best).toBeGreaterThan(seedScore);
    expect(best).toBeLessThanOrEqual(12);
    console.log(`[discovery] sidon-100 best after 15 gens: ${best} (seed ${seedScore}, optimum 12)`);
  });

  it("is deterministic for the same seed", async () => {
    const a = await runGenerations(E, null, "sidon-100", 3, { children: 2, llm: "off", seed: "same" });
    await freshState();
    const b = await runGenerations(E, null, "sidon-100", 3, { children: 2, llm: "off", seed: "same" });
    expect(a.map((s) => s.children.map((c) => [c.op, c.score]))).toEqual(b.map((s) => s.children.map((c) => [c.op, c.score])));
  });

  it("uses LLM mutations through the LabLLM in mock mode, and falls back to deterministic ones when the budget runs out", async () => {
    const lab = new LabLLM(E, { maxCalls: 2, share: 1 });
    expect(lab.mode).toBe("mock");
    const steps = await runGenerations(E, lab, "sidon-200", 8, { children: 3, seed: "llm" });
    const llmKids = steps.flatMap((s) => s.children).filter((c) => c.op === "llm");
    expect(lab.calls).toBeLessThanOrEqual(2);
    if (lab.calls === 2) expect(steps.some((s) => s.llmDisabledReason?.startsWith("tick"))).toBe(true);
    expect(steps.reduce((a, s) => a + s.evaluated, 0)).toBeGreaterThanOrEqual(8 * 3 - 3);
    // a custom LLM: the operator is used, its program is evaluated, and garbage replies are tolerated
    const replies = ["no code at all", "```js\nfunction construct(input){ return [1,2,4,8,13,21,31,45,66,81,97,123,148,182] }\n```"];
    let i = 0;
    const custom = async () => replies[i++ % replies.length];
    const more = await runGenerations(E, null, "sidon-200", 6, { children: 3, seed: "custom", llm: custom });
    const kids = more.flatMap((s) => s.children);
    expect(i).toBeGreaterThan(0);
    expect(kids.some((c) => c.op === "llm" && c.valid)).toBe(true);
    const top = await topPrograms(E, "sidon-200", "max", 5);
    expect(top.some((p) => p.lineage?.includes("llm"))).toBe(true);
    console.log(`[discovery] llm kids (mock lab): ${llmKids.length}; custom-llm best: ${more[more.length - 1].best}`);
  });

  it("migrates island champions around the ring", async () => {
    const steps = await runGenerations(E, null, "golomb-11", 5, { children: 1, llm: "off", migrateEvery: 2, seed: "mig" });
    const migs = steps.filter((s) => s.migrated);
    expect(migs.length).toBeGreaterThan(0);
    expect(migs[0].migrated!.to).toBe((migs[0].migrated!.from + 1) % 3);
  });

  it("works on every problem family for one cheap step", async () => {
    for (const id of ["capset-4", "points-square-10", "tammes-13", "ramsey-3-5", "clinics-2026-k5"]) {
      const r = await stepGeneration(E, null, id, { children: 2, llm: "off", seed: 1 });
      expect(r.children[0], id).toMatchObject({ op: "seed", valid: true });
      expect(r.best, id).not.toBeNull();
    }
  });

  it("free-plan profile: one child per step with a tiny fuel cap; over-budget programs fail cleanly", async () => {
    const r = await stepGeneration(E, null, "golomb-10", { ...DISCOVERY_FREE_PLAN, llm: "off", seed: 1 });
    expect(r.evaluated).toBe(1);
    expect(r.children[0]).toMatchObject({ op: "seed", valid: true });
    const heavy = await stepGeneration(E, null, "clinics-2026-k5", { ...DISCOVERY_FREE_PLAN, constructFuel: 1, llm: "off", seed: 1 });
    expect(heavy.children[0].op).toBe("seed");
  });
});
