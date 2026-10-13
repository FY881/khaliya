import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { baselines, strongBaseline } from "../../src/eval/baselines";
import { FAMILIES, FAMILY_MAP, STARTER_SUITES } from "../../src/eval/families";
import { LabLLM } from "../../src/eval/llm";
import { parseAnswer, solveItem } from "../../src/eval/solver";
import { ensureSuite, getItem, resultsFor } from "../../src/eval/store";
import type { ItemSpec } from "../../src/eval/types";
import { GATES, leakage, structureProblems, validateItem } from "../../src/eval/validate";
import { freshState } from "../helpers";

const E = env as Env;
const lab = () => new LabLLM(E, { maxCalls: 5000, share: 1 });

beforeEach(async () => {
  await freshState();
  for (const s of STARTER_SUITES) await ensureSuite(E, s);
});

function gen(kind: string, seed: string, d = 3, split: ItemSpec["split"] = "private"): ItemSpec {
  const f = FAMILY_MAP[kind];
  const suite = f.suite === "*" ? "code-core" : f.suite;
  const g = f.generate(seed, d);
  return { suite_id: suite, task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: d, tags: g.tags, split };
}

const failedGate = (r: { gates: { gate: string; pass: boolean }[] }) => r.gates.find((g) => !g.pass)?.gate;

describe("solver + baselines", () => {
  it("solver never sees the reference; strong solves, weak fails", async () => {
    const it = gen("arith", "s1", 3);
    const marked = { ...it, reference: "SECRET-REFERENCE-123" };
    const { strong, weak } = await baselines("builder");
    const l = lab();
    const s = await solveItem(l, strong, marked);
    expect(s.raw).not.toContain("SECRET-REFERENCE");
    expect(s.answer).toBe(it.reference);
    expect((await solveItem(l, weak, it)).answer).not.toBe(it.reference);
    expect(strong.id).toMatch(/^g_/);
    expect(strong.id).not.toBe(weak.id);
    expect(strong.id).toBe((await strongBaseline("builder")).id);
  });

  it("parseAnswer handles strings, numbers, arrays and raw text", () => {
    expect(parseAnswer('{"answer": "x"}')).toBe("x");
    expect(parseAnswer('{"answer": 42}')).toBe("42");
    expect(parseAnswer('{"answer": [1,2]}')).toBe("[1,2]");
    expect(parseAnswer("plain")).toBe("plain");
  });
});

describe("validation pipeline", () => {
  it("a good family item passes every gate in order and is persisted active", async () => {
    const r = await validateItem(E, lab(), gen("gcd", "good", 3), { author: "owner" });
    expect(r.status).toBe("active");
    expect(r.validated).toBe(true);
    expect(r.gates.map((g) => g.gate)).toEqual([...GATES]);
    expect(r.gates.every((g) => g.pass)).toBe(true);
    expect(r.quality).toBeGreaterThan(0.5);
    expect(r.quality).toBeLessThanOrEqual(1);
    const item = await getItem(E, r.item_id);
    expect(item).toMatchObject({ status: "active", author: "owner", role: "builder" });
    expect(item!.quality).toBe(r.quality);
    expect(item!.validation?.outcome).toBe("active");
    // baseline answers were recorded
    const res = await resultsFor(E, r.item_id);
    expect(res.filter((x) => x.context === "validation")).toHaveLength(2);
  });

  it("rubric items validate too (judge panel)", async () => {
    const r = await validateItem(E, lab(), gen("plan_brief", "rub", 3));
    expect(r.status).toBe("active");
  });

  it("structure gate: malformed checker / short task / bad difficulty / unknown suite", async () => {
    const bad = { ...gen("gcd", "st"), checker: { type: "regex", pattern: "(a+)+" } } as ItemSpec;
    expect(structureProblems(bad).join()).toContain("ReDoS");
    const r = await validateItem(E, lab(), bad);
    expect(r.status).toBe("rejected");
    expect(failedGate(r)).toBe("structure");
    expect((await validateItem(E, lab(), { ...gen("gcd", "st2"), task: "short" })).gates[0].pass).toBe(false);
    expect((await validateItem(E, lab(), { ...gen("gcd", "st3"), difficulty: 11 })).gates[0].pass).toBe(false);
    const u = await validateItem(E, lab(), { ...gen("gcd", "st4"), suite_id: "nope" });
    expect(u.reason).toContain("unknown suite");
    expect(u.item).toBeNull(); // nothing persisted without a suite
  });

  it("dedupe gate: exact duplicate, near-duplicate, and reference leakage", async () => {
    const l = lab();
    // long expression (generated at d8) but labelled d3 so the strong baseline solves it
    const g8 = FAMILY_MAP.arith.generate("dup", 8);
    const first: ItemSpec = { suite_id: "code-core", task: g8.task, inputs: g8.inputs, checker: g8.checker, reference: g8.reference, difficulty: 3, tags: g8.tags, split: "private" };
    expect((await validateItem(E, l, first)).status).toBe("active");
    const exact = await validateItem(E, l, { ...first, task: first.task.toUpperCase() + "  " });
    expect(exact.status).toBe("rejected");
    expect(failedGate(exact)).toBe("dedupe");
    expect(exact.duplicate_of).toBe(exact.item_id);

    const expr = String(first.inputs.expression);
    const nudged = expr.replace(/\d+$/, (m) => String(Number(m) + 1));
    const near = { ...first, task: first.task.replace("Evaluate", "Please evaluate"), inputs: { kind: "arith", expression: nudged } };
    near.reference = FAMILY_MAP.arith.solve(near.inputs);
    near.checker = { type: "numeric", value: Number(near.reference), tolerance: 0 };
    const nr = await validateItem(E, l, near);
    expect(failedGate(nr)).toBe("dedupe");
    expect(nr.reason).toContain("near-duplicate");

    const leaky = gen("gcd", "leak", 3);
    leaky.task = `${leaky.task} (Hint: the answer is ${leaky.reference}.)`;
    expect(leakage(leaky)).toContain("task");
    const lr = await validateItem(E, l, leaky);
    expect(failedGate(lr)).toBe("dedupe");
    expect(lr.reason).toContain("leakage");
    expect((await getItem(E, lr.item_id))?.status).toBe("rejected"); // persisted as rejected
  });

  it("leakage rule never flags generated family items", () => {
    const flagged: string[] = [];
    for (const f of FAMILIES)
      for (const d of [1, 3, 6, 9])
        for (const s of ["a", "b", "c"]) {
          const g = f.generate(`leak:${f.kind}:${s}:${d}`, d, s.charCodeAt(0) % 3);
          const why = leakage(g);
          if (why) flagged.push(`${f.kind} d${d}/${s}: ${why}`);
        }
    expect(flagged).toEqual([]);
  });

  it("solvable gate: reference that fails its own checker / family solution disagrees with checker", async () => {
    const wrongRef = gen("gcd", "sol", 3);
    wrongRef.reference = String(Number(wrongRef.reference) + 1);
    const r = await validateItem(E, lab(), wrongRef);
    expect(failedGate(r)).toBe("solvable");
    expect(r.reason).toContain("reference");

    // checker & reference agree with each other but not with the inputs → the family solver exposes it
    const mismatch = gen("gcd", "sol2", 3);
    const fake = Number(mismatch.reference) + 1;
    mismatch.reference = String(fake);
    mismatch.checker = { type: "numeric", value: fake, tolerance: 0 };
    const m = await validateItem(E, lab(), mismatch);
    expect(failedGate(m)).toBe("solvable");
    expect(m.reason).toContain("family");
  });

  it("anti-gaming gate: a trivially gameable checker is rejected", async () => {
    const it: ItemSpec = {
      suite_id: "critique-core",
      task: "Is the following claim about the ledger correct? Reply with a single word.",
      inputs: { claim: "The ledger total of 41 and 17 is 58." },
      checker: { type: "regex", pattern: "yes", flags: "i" },
      reference: "yes",
      difficulty: 2,
      tags: [],
      split: "private",
    };
    const r = await validateItem(E, lab(), it);
    expect(failedGate(r)).toBe("anti_gaming");
    expect(r.reason).toContain("gameable");
  });

  it("anti-gaming gate: a checker that also accepts the family's plausible wrong answer is rejected", async () => {
    const it = gen("arith", "loose", 3);
    const wrong = Number(FAMILY_MAP.arith.wrong(it.inputs));
    const right = Number(it.reference);
    it.checker = { type: "numeric", value: right, tolerance: Math.abs(right - wrong) + 1 };
    const r = await validateItem(E, lab(), it);
    expect(failedGate(r)).toBe("anti_gaming");
    expect(JSON.stringify(r.gates.find((g) => g.gate === "anti_gaming"))).toContain("family_wrong_answer");
  });

  it("discriminative gate: weak passes too → rejected; too hard → reserve; canary exempt", async () => {
    const l = lab();
    const strong = await strongBaseline("builder");
    // weak "baseline" that is as good as the strong one → item does not discriminate
    const easy = await validateItem(E, l, gen("gcd", "disc", 2), { weak: { ...strong, id: "g_fake_weak" } });
    expect(failedGate(easy)).toBe("discriminative");
    expect(easy.reason).toContain("weak baseline passes");

    const hard = await validateItem(E, l, gen("arith", "hard", 10));
    expect(hard.status).toBe("reserve");
    expect(hard.validated).toBe(false);
    expect(hard.gates.every((g) => g.pass)).toBe(true);
    expect((await getItem(E, hard.item_id))?.status).toBe("reserve");

    const g = FAMILY_MAP.safety.generate("can", 1, 0);
    const canary = await validateItem(E, l, { suite_id: "code-core", task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: 1, tags: g.tags, split: "canary" });
    expect(canary.status).toBe("active");
    expect(canary.gates.find((x) => x.gate === "discriminative")?.reason).toContain("exempt");
  });

  it("flake gate: an item whose strong verdict changes across reruns is rejected", async () => {
    const l = lab();
    const strong = await strongBaseline("builder");
    const it = gen("gcd", "flaky", 3);
    it.task = `${it.task} MOCK:flaky`;
    // align the mock's alternating flaky counter so the first strong solve inside validation is correct
    const probe = await solveItem(l, strong, it);
    if (probe.answer === it.reference) await solveItem(l, strong, it);
    const r = await validateItem(E, l, it);
    expect(r.status).toBe("rejected");
    expect(failedGate(r)).toBe("flake");
    expect(r.gates.find((g) => g.gate === "discriminative")?.pass).toBe(true);
  });

  it("critic gate: the Critic rejects an item it finds ambiguous", async () => {
    const it = gen("gcd", "crit", 3);
    it.tags = [...it.tags, "MOCK:bad"];
    // the critic sees the full item; tags are not in the review payload, so mark the task instead
    it.task = `${it.task} (MOCK:bad)`;
    const r = await validateItem(E, lab(), it);
    expect(failedGate(r)).toBe("critic");
    expect(r.reason).toBe("critic: rejected");
    expect(String(r.gates.find((g) => g.gate === "critic")?.reason)).toContain("ambiguous");
  });

  it("persist:false validates without writing", async () => {
    const r = await validateItem(E, lab(), gen("gcd", "nop", 3), { persist: false });
    expect(r.status).toBe("active");
    expect(r.item).toBeNull();
    expect(await getItem(E, r.item_id)).toBeNull();
  });
});
