import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { FAMILY_MAP, STARTER_SUITES } from "../../src/eval/families";
import {
  bumpChecks,
  countItems,
  ensureSuite,
  findNearDuplicate,
  getItem,
  getSuite,
  insertItem,
  itemHash,
  itemIdFromHash,
  listItems,
  listPublicItems,
  listSuites,
  nearDupScore,
  recordResult,
  resultsFor,
  setItemStatus,
  updateSuite,
} from "../../src/eval/store";
import type { ItemSpec } from "../../src/eval/types";
import { freshState } from "../helpers";

beforeEach(freshState);
const E = env as Env;
const CODE = STARTER_SUITES.find((s) => s.id === "code-core")!;

function spec(seed: string, split: ItemSpec["split"] = "public", kind = "arith", d = 3): ItemSpec {
  const g = FAMILY_MAP[kind].generate(seed, d);
  return { suite_id: CODE.id, task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: d, tags: g.tags, split };
}

describe("eval store", () => {
  it("suites: ensure is idempotent and keeps level/saturation", async () => {
    await ensureSuite(E, CODE);
    await updateSuite(E, CODE.id, { level: 7, saturation: 0.95 });
    await ensureSuite(E, CODE);
    const s = await getSuite(E, CODE.id);
    expect(s).toMatchObject({ id: "code-core", role: "builder", level: 7, saturation: 0.95 });
    expect((await listSuites(E)).length).toBe(1);
  });

  it("hash is suite-scoped and normalisation-insensitive", async () => {
    const a = await itemHash("code-core", "Sort  THE numbers!", { kind: "x", n: [1, 2] });
    const b = await itemHash("code-core", "sort the numbers", { n: [1, 2], kind: "x" });
    const c = await itemHash("research-core", "sort the numbers", { n: [1, 2], kind: "x" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(itemIdFromHash(a)).toMatch(/^ei_[0-9a-f]{24}$/);
  });

  it("insert, read back, duplicate insert returns null", async () => {
    await ensureSuite(E, CODE);
    const s = spec("one");
    const it1 = await insertItem(E, s, { role: "builder", author: "owner", status: "active", quality: 0.8 });
    expect(it1).toMatchObject({ suite_id: "code-core", status: "active", quality: 0.8, reference: s.reference, inputs: s.inputs });
    expect(it1!.checker).toEqual(s.checker);
    expect(await insertItem(E, { ...s, task: s.task.toUpperCase() }, { role: "builder", author: "owner" })).toBeNull();
    expect((await getItem(E, it1!.id))!.id).toBe(it1!.id);
  });

  it("near-duplicates: same template + near-identical inputs is a dup; same template + new data is not", async () => {
    await ensureSuite(E, CODE);
    const base: ItemSpec = { ...spec("nd"), inputs: { kind: "arith", expression: "12 + 7 * 3 - 4 * 9 + 15 * 2 - 8" } };
    await insertItem(E, base, { role: "builder", author: "owner", status: "active" });
    const tweak = { task: base.task + " ", inputs: { kind: "arith", expression: "12 + 7 * 3 - 4 * 9 + 15 * 2 - 9" } };
    expect(nearDupScore(base, tweak)).toBeGreaterThanOrEqual(0.85);
    expect((await findNearDuplicate(E, CODE.id, tweak))?.similarity).toBeGreaterThanOrEqual(0.85);
    const fresh = spec("totally-different-seed", "public", "arith", 6);
    expect(await findNearDuplicate(E, CODE.id, fresh)).toBeNull();
    // other suites never collide
    expect(await findNearDuplicate(E, "research-core", tweak)).toBeNull();
    // rejected items are ignored
    const dup = await findNearDuplicate(E, CODE.id, tweak);
    await setItemStatus(E, dup!.id, "rejected", { reason: "x" });
    expect(await findNearDuplicate(E, CODE.id, tweak)).toBeNull();
  });

  it("agents see only active public items and never the reference or checker", async () => {
    await ensureSuite(E, CODE);
    const pub = await insertItem(E, spec("p1", "public"), { role: "builder", author: "owner", status: "active" });
    await insertItem(E, spec("p2", "public", "gcd"), { role: "builder", author: "owner", status: "reserve" });
    await insertItem(E, spec("p3", "private", "json_sum"), { role: "builder", author: "owner", status: "active" });
    await insertItem(E, spec("p4", "canary", "count_char"), { role: "builder", author: "owner", status: "active" });
    const seen = await listPublicItems(E, CODE.id);
    expect(seen.map((s) => s.id)).toEqual([pub!.id]);
    const v = seen[0] as unknown as Record<string, unknown>;
    expect(v.reference).toBeUndefined();
    expect(v.checker).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(`"value":${pub!.reference}`);
    expect(typeof v.format).toBe("string");
    // owner view sees all four, with references
    const all = await listItems(E, { suite_id: CODE.id });
    expect(all.length).toBe(4);
    expect(all.every((i) => i.reference.length > 0)).toBe(true);
    expect((await listItems(E, { suite_id: CODE.id, split: ["private", "canary"] })).length).toBe(2);
    const counts = await countItems(E, CODE.id);
    expect(counts).toMatchObject({ total: 4, by_status: { active: 3, reserve: 1 } });
    expect(counts.by_split_status["public:active"]).toBe(1);
  });

  it("results + check counters", async () => {
    await ensureSuite(E, CODE);
    const it1 = (await insertItem(E, spec("r"), { role: "builder", author: "owner", status: "active" }))!;
    await recordResult(E, { item_id: it1.id, genome_id: "g_a", context: "recheck", pass: true, score: 1, answer: "5", judge: { method: "deterministic" } });
    await recordResult(E, { item_id: it1.id, genome_id: "g_b", context: "sandbox", pass: false, score: 0 });
    expect((await resultsFor(E, it1.id)).length).toBe(2);
    const r = await resultsFor(E, it1.id, { genome_id: "g_a" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ pass: true, score: 1, answer: "5", judge: { method: "deterministic" } });
    expect(await bumpChecks(E, it1.id, false)).toEqual({ checks: 1, flakes: 0 });
    expect(await bumpChecks(E, it1.id, true)).toEqual({ checks: 2, flakes: 1 });
    await setItemStatus(E, it1.id, "retired", { reason: "flaky" });
    expect(await getItem(E, it1.id)).toMatchObject({ status: "retired", status_reason: "flaky", quality: null });
  });
});
