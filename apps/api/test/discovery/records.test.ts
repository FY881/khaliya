import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stepGeneration } from "../../src/discovery/evolve";
import { getBuiltinProblem } from "../../src/discovery/problems";
import { bestRecord, compareToKnown, getRecord, listRecords, reverifyPending, reverifyRecord, upsertProblem, type Verification } from "../../src/discovery/store";
import type { ProblemDef } from "../../src/discovery/types";
import type { Env } from "../../src/env";
import { freshState } from "../helpers";

const E = env as unknown as Env;
beforeEach(freshState);

/** A copy of a built-in problem registered as an owner problem with a different published value. */
async function variant(id: string, base: string, bestKnown: number | null): Promise<ProblemDef> {
  const b = getBuiltinProblem(base)!;
  const def: ProblemDef = { ...b, id, source: "owner", best_known: { score: bestKnown, status: "best_known", source: "test citation (synthetic)" }, describe: undefined };
  await upsertProblem(E, def);
  return def;
}

describe("records and certificates", () => {
  it("a new best is a candidate; two independent re-verifications make it verified", async () => {
    const r = await stepGeneration(E, null, "golomb-10", { children: 1, llm: "off", seed: 1 });
    expect(r.newRecord).toMatchObject({ score: 9841, vs_known: "below" });
    let rec = (await getRecord(E, r.newRecord!.id))!;
    expect(rec).toMatchObject({ status: "candidate", verified_count: 0, best_known_score: 55 });
    expect(JSON.parse(rec.solution)).toHaveLength(10);
    expect(rec.verifier_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.instance_hash).toMatch(/^[0-9a-f]{64}$/);

    rec = await reverifyRecord(E, rec.id, { checkReproducible: true });
    expect(rec).toMatchObject({ status: "candidate", verified_count: 1, reproducible: 1 });
    rec = await reverifyRecord(E, rec.id);
    expect(rec).toMatchObject({ status: "verified", verified_count: 2 });
    const v = JSON.parse(rec.verifications) as Verification[];
    expect(v).toHaveLength(2);
    expect(new Set([rec.eval_seed, ...v.map((x) => x.seed)]).size).toBe(3); // every run used a different seed
    expect(v.every((x) => x.agrees && x.valid)).toBe(true);
    // verified records are final
    expect((await reverifyRecord(E, rec.id)).verified_count).toBe(2);
  });

  it("beating the published best is flagged 'beats_known_needs_review', never claimed", async () => {
    await variant("golomb-10-test", "golomb-10", 10000); // pretend the literature said 10000
    const r = await stepGeneration(E, null, "golomb-10-test", { children: 1, llm: "off", seed: 1 });
    expect(r.newRecord).toMatchObject({ score: 9841, vs_known: "beats" });
    await reverifyRecord(E, r.newRecord!.id);
    let rec = (await getRecord(E, r.newRecord!.id))!;
    expect(rec.status).toBe("candidate"); // one re-verification is not enough
    rec = await reverifyRecord(E, rec.id);
    expect(rec.status).toBe("beats_known_needs_review");
    expect(rec.status_reason).toMatch(/needs human review/i);
    expect(rec.status_reason).toContain("test citation");
    expect(await listRecords(E, { status: "verified" })).toHaveLength(0);
  });

  it("a tampered certificate or a changed verifier is rejected on re-verification", async () => {
    const r = await stepGeneration(E, null, "sidon-100", { children: 1, llm: "off", seed: 1 });
    // tamper: claim a better score than the solution has
    await E.DB.prepare(`UPDATE discovery_records SET score = score + 1 WHERE id = ?`).bind(r.newRecord!.id).run();
    const rec = await reverifyRecord(E, r.newRecord!.id);
    expect(rec.status).toBe("rejected");
    expect(rec.status_reason).toMatch(/disagrees/);
    // a rejected record no longer counts as the best
    expect(await bestRecord(E, "sidon-100", "max")).toBeNull();

    const def = await variant("sidon-v", "sidon-100", 12);
    const r2 = await stepGeneration(E, null, "sidon-v", { children: 1, llm: "off", seed: 1 });
    await upsertProblem(E, { ...def, verifier: def.verifier + "\n// v2" });
    const rec2 = await reverifyRecord(E, r2.newRecord!.id);
    expect(rec2.status).toBe("rejected");
    expect(rec2.status_reason).toMatch(/verifier changed/);
  });

  it("reverifyPending does a bounded amount of work", async () => {
    await stepGeneration(E, null, "golomb-12", { children: 3, llm: "off", seed: 3 });
    const pending = await listRecords(E, { problem_id: "golomb-12", status: "candidate" });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const done = await reverifyPending(E, { max: 1 });
    expect(done).toHaveLength(1);
    expect(done[0].verified_count).toBe(1);
  });

  it("compareToKnown honours direction and tolerance", () => {
    expect(compareToKnown("min", 54, 55)).toBe("beats");
    expect(compareToKnown("min", 55, 55)).toBe("matches");
    expect(compareToKnown("max", 63.4349488 + 1e-8, 63.4349488, 1e-6)).toBe("matches");
    expect(compareToKnown("max", 12, null)).toBe("unknown");
    expect(compareToKnown("max", 11, 12)).toBe("below");
  });
});
