import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { strongBaseline, weakBaseline } from "../../src/eval/baselines";
import { FAMILY_MAP, STARTER_SUITES } from "../../src/eval/families";
import { authorHarder, checkSaturation, disagreements, recheckItem, retireFlaky } from "../../src/eval/ladder";
import { LabLLM } from "../../src/eval/llm";
import { seedSuite } from "../../src/eval/seed";
import { ensureSuite, getItem, getSuite, insertItem, listItems, recordResult } from "../../src/eval/store";
import type { ItemSpec } from "../../src/eval/types";
import { freshState } from "../helpers";

const E = env as Env;
const lab = () => new LabLLM(E, { maxCalls: 20000, share: 1 });
const CODE = STARTER_SUITES.find((s) => s.id === "code-core")!;

beforeEach(freshState);

describe("difficulty ladder", () => {
  it("saturated suite (champion > 90%) gets harder validated items at level+2 and an evaluator task", async () => {
    const l = lab();
    await seedSuite(E, l, CODE);
    const before = await getSuite(E, CODE.id);
    expect(before!.level).toBe(5);
    const queued: { agent: string; task: string }[] = [];
    const r = await checkSaturation(E, l, CODE.id, {
      genome: await strongBaseline("builder"),
      count: 2,
      enqueue: async (agent, task) => (queued.push({ agent, task }), "run_test"),
    });
    expect(r.n).toBe(8);
    expect(r.pass_rate).toBe(1);
    expect(r.saturated).toBe(true);
    expect(r.ladder).not.toBeNull();
    expect(r.ladder!.difficulty).toBe(7);
    expect(r.ladder!.active.length + r.ladder!.reserve.length).toBe(2);
    expect(r.ladder!.evaluator_run).toBe("run_test");
    expect(queued[0].agent).toBe("a_evaluator");
    expect(queued[0].task).toContain("AUTHOR_EVAL_ITEMS");
    expect(queued[0].task).toContain("DIFFICULTY: 7");
    const after = await getSuite(E, CODE.id);
    expect(after).toMatchObject({ level: 7, saturation: 1 });
    expect(after!.saturated_at).not.toBeNull();
    expect(after!.ladder_requested_at).not.toBeNull();
    const ladderItems = await listItems(E, { suite_id: CODE.id, author: "system:ladder" });
    expect(ladderItems.length).toBeGreaterThanOrEqual(2);
    for (const it of ladderItems) {
      expect(it.difficulty).toBe(7);
      expect(it.split).toBe("private");
      expect(it.tags).toContain("ladder");
      expect(["active", "reserve", "rejected"]).toContain(it.status);
    }
  });

  it("a weak champion does not saturate the suite; nothing is authored", async () => {
    const l = lab();
    await seedSuite(E, l, CODE);
    const r = await checkSaturation(E, l, CODE.id, { genome: await weakBaseline("builder"), enqueue: null });
    expect(r.saturated).toBe(false);
    expect(r.pass_rate).toBeLessThan(0.9);
    expect(r.ladder).toBeNull();
    expect((await getSuite(E, CODE.id))!.level).toBe(5);
  });

  it("authorHarder caps difficulty at 10 and parks unsolvable items in reserve", async () => {
    const l = lab();
    await ensureSuite(E, CODE, 9);
    const r = await authorHarder(E, l, CODE.id, { count: 1, enqueue: null });
    expect(r.difficulty).toBe(10);
    expect(r.level).toBe(10);
    expect(r.reserve.length + r.active.length).toBe(1);
    expect(r.evaluator_run).toBeNull();
  });
});

describe("flake auto-retire", () => {
  async function item(seed: string, task?: string) {
    await ensureSuite(E, CODE);
    const g = FAMILY_MAP.gcd.generate(seed, 3);
    const spec: ItemSpec = { suite_id: CODE.id, task: task ?? g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: 3, tags: g.tags, split: "private" };
    return (await insertItem(E, spec, { role: "builder", author: "owner", status: "active" }))!;
  }

  it("disagreements counts verdict flips per genome", () => {
    expect(disagreements([])).toBe(0);
    expect(disagreements([{ genome_id: "a", pass: true }, { genome_id: "a", pass: true }])).toBe(0);
    expect(disagreements([{ genome_id: "a", pass: true }, { genome_id: "b", pass: false }, { genome_id: "a", pass: false }, { genome_id: "a", pass: true }])).toBe(2);
  });

  it("recheck: a flaky item is retired after its second disagreement; a stable one never is", async () => {
    const l = lab();
    const g = await strongBaseline("builder");
    const flaky = await item("fl", `${FAMILY_MAP.gcd.generate("fl", 3).task} MOCK:flaky`);
    const stable = await item("st");
    const out = [];
    for (let k = 0; k < 4; k++) out.push(await recheckItem(E, l, (await getItem(E, flaky.id))!, g));
    expect(out.map((o) => o.flaked)).toEqual([false, true, true, true]);
    expect(out.find((o) => o.retired)?.flakes).toBe(2);
    expect((await getItem(E, flaky.id))).toMatchObject({ status: "retired" });
    expect((await getItem(E, flaky.id))!.status_reason).toContain("flaky");

    for (let k = 0; k < 3; k++) await recheckItem(E, l, (await getItem(E, stable.id))!, g);
    expect(await getItem(E, stable.id)).toMatchObject({ status: "active", checks: 3, flakes: 0 });
  });

  it("retireFlaky scans recorded results without LLM calls", async () => {
    const a = await item("ra");
    const b = await item("rb");
    for (const pass of [true, false, true]) await recordResult(E, { item_id: a.id, genome_id: "g_x", context: "tournament", pass, score: pass ? 1 : 0 });
    for (const pass of [true, false]) await recordResult(E, { item_id: b.id, genome_id: "g_x", context: "tournament", pass, score: pass ? 1 : 0 });
    const r = await retireFlaky(E, CODE.id);
    expect(r.retired).toEqual([a.id]);
    expect(await getItem(E, a.id)).toMatchObject({ status: "retired", flakes: 2 });
    expect(await getItem(E, b.id)).toMatchObject({ status: "active", flakes: 1 });
  });
});
