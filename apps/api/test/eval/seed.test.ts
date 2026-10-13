import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { STARTER_SUITES } from "../../src/eval/families";
import { LabLLM } from "../../src/eval/llm";
import { SEED_TARGETS, seedCandidate, seedEvalSuites } from "../../src/eval/seed";
import { countItems, listItems, listPublicItems, listSuites } from "../../src/eval/store";
import { freshState } from "../helpers";

const E = env as Env;
const lab = () => new LabLLM(E, { maxCalls: 20000, share: 1 });

beforeEach(freshState);

describe("eval seeding", () => {
  it("seeds 4 suites × (6 public + 8 private + 2 canary) validated items, idempotently", async () => {
    const s1 = await seedEvalSuites(E, lab());
    if (!s1.complete) console.log(JSON.stringify(s1.suites.map((s) => ({ id: s.suite_id, splits: s.splits, rej: s.rejections })), null, 1));
    expect(s1.complete).toBe(true);
    expect(s1.active).toBe(4 * 16);
    expect((await listSuites(E)).map((s) => s.id).sort()).toEqual(["code-core", "critique-core", "planning-core", "research-core"]);

    for (const def of STARTER_SUITES) {
      const c = await countItems(E, def.id);
      for (const split of ["public", "private", "canary"] as const) expect(c.by_split_status[`${split}:active`]).toBe(SEED_TARGETS[split]);
      const active = await listItems(E, { suite_id: def.id, status: "active" });
      expect(active.every((i) => i.author === "system:seed" && typeof i.quality === "number" && i.quality! > 0 && i.validation?.outcome === "active")).toBe(true);
      expect(active.filter((i) => i.split === "canary").every((i) => i.inputs.kind === "safety")).toBe(true);
      expect((await listPublicItems(E, def.id)).length).toBe(6);
    }

    // second run: nothing new, no LLM spend
    const totalBefore = (await listItems(E, { limit: 5000 })).length;
    const s2 = await seedEvalSuites(E, lab());
    expect(s2.created).toBe(0);
    expect(s2.llm_calls).toBe(0);
    expect(s2.complete).toBe(true);
    expect((await listItems(E, { limit: 5000 })).length).toBe(totalBefore);
  }, 90_000);

  it("candidates are deterministic and rotate families", () => {
    const def = STARTER_SUITES[1];
    expect(seedCandidate(def, "public", 3)).toEqual(seedCandidate(def, "public", 3));
    const kinds = new Set(Array.from({ length: 6 }, (_, n) => seedCandidate(def, "private", n).inputs.kind));
    expect(kinds.size).toBeGreaterThan(3);
    expect(seedCandidate(def, "canary", 0).inputs.kind).toBe("safety");
  });
});
