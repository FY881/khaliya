import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stepGeneration } from "../../src/discovery/evolve";
import { builtinProblems } from "../../src/discovery/problems";
import { getProblemRow } from "../../src/discovery/store";
import { submitProblem, validateProblemSubmission, type ProblemSubmission } from "../../src/discovery/submit";
import type { Env } from "../../src/env";
import { freshState } from "../helpers";

const E = env as unknown as Env;
beforeEach(freshState);

// Owner problem: largest subset of [1..N] with no 3-term arithmetic progression (Salem–Spencer set).
const AP_VERIFIER = `function verify(x) {
  try {
    var N = x.instance.N, s = x.solution;
    if (!Array.isArray(s) || s.length > N) return { valid: false, detail: "array of at most N integers" };
    var has = {};
    for (var i = 0; i < s.length; i++) {
      var v = s[i];
      if (typeof v !== "number" || v !== Math.floor(v) || v < 1 || v > N) return { valid: false, detail: "element out of range" };
      if (has[v]) return { valid: false, detail: "duplicate" };
      has[v] = 1;
    }
    for (var a = 0; a < s.length; a++) for (var b = 0; b < s.length; b++) {
      if (s[a] < s[b] && has[2 * s[b] - s[a]]) return { valid: false, detail: "3-AP " + s[a] + "," + s[b] };
    }
    return { valid: true, score: s.length, detail: "size " + s.length };
  } catch (e) { return { valid: false, detail: "malformed" }; }
}`;

const base = (over: Partial<ProblemSubmission> = {}): ProblemSubmission => ({
  id: "salem-spencer-30",
  title_en: "Largest 3-AP-free subset of [1..30]",
  statement_en: "Choose as many integers from 1..30 as possible with no three in arithmetic progression.",
  direction: "max",
  instance: { N: 30 },
  verifier: AP_VERIFIER,
  good: [
    [1, 2, 4, 5, 10, 11, 13, 14],
    [1, 2, 4, 8, 9, 11],
  ],
  bad: [
    [1, 2, 3],
    [1, 5, 9, 2],
    [0, 4],
  ],
  best_known: { score: 12, source: "OEIS A003002 (largest 3-AP-free subset of [1..n]), https://oeis.org/A003002", status: "proven_optimal" },
  author: "owner",
  ...over,
});

describe("problem submission validation", () => {
  it("accepts a well-formed owner problem and the engine can evolve it", async () => {
    const res = await submitProblem(E, base());
    expect(res.report.reason).toBeUndefined();
    expect(res.status).toBe("accepted");
    expect(res.report.gates.every((g) => g.pass)).toBe(true);
    expect(res.report.warnings.join(" ")).toMatch(/default seed/);
    const row = (await getProblemRow(E, "salem-spencer-30"))!;
    expect(row).toMatchObject({ status: "active", source: "owner", best_known_score: 12 });
    const step = await stepGeneration(E, null, "salem-spencer-30", { children: 2, llm: "off" });
    expect(step.children[0]).toMatchObject({ op: "seed", valid: true, score: 8 });
  });

  it("rejects verifiers that accept a known-bad solution", async () => {
    const lax = AP_VERIFIER.replace('if (s[a] < s[b] && has[2 * s[b] - s[a]]) return { valid: false, detail: "3-AP " + s[a] + "," + s[b] };', "");
    const r = await validateProblemSubmission(base({ verifier: lax }));
    expect(r).toMatchObject({ status: "rejected" });
    expect(r.reason).toMatch(/^bad: verifier accepted bad #0/);
    expect(r.gates.find((g) => g.gate === "determinism")).toMatchObject({ skipped: true });
  });

  it("rejects verifiers that reject a known-good solution", async () => {
    const strict = AP_VERIFIER.replace("s.length > N", "s.length > 7");
    expect((await validateProblemSubmission(base({ verifier: strict }))).reason).toMatch(/^good: verifier rejected good #0/);
  });

  it("rejects verifiers that crash on garbage or on a bad solution", async () => {
    const crashy = AP_VERIFIER.replace("var v = s[i];", "var v = s[i]; if (v === 3) throw new Error('boom');").replace("  try {", "  {").replace("} catch (e) { return { valid: false, detail: \"malformed\" }; }", "}");
    const r = await validateProblemSubmission(base({ verifier: crashy }));
    expect(r.reason).toMatch(/^bad: verifier crashed on bad #0/);
    const noGuard = `function verify(x) { var s = x.solution; if (s.length > 30) return { valid: false }; return { valid: s.length === 2 && s[0] === 1, score: s.length }; }`;
    const r2 = await validateProblemSubmission(base({ verifier: noGuard, good: [[1, 2], [1, 3]], bad: [[2, 3], [5]] }));
    expect(r2.reason).toMatch(/^fuzz: verifier throw on garbage null/);
  });

  it("rejects non-deterministic verifiers", async () => {
    const flaky = AP_VERIFIER.replace('return { valid: true, score: s.length, detail: "size " + s.length };', "return { valid: true, score: s.length + (rand() < 2 ? rand() : 0) };");
    expect((await validateProblemSubmission(base({ verifier: flaky }))).reason).toMatch(/^determinism:/);
  });

  it("rejects verifiers that loop forever / blow the fuel budget", async () => {
    const slow = AP_VERIFIER.replace("var has = {};", "var has = {}; for (var z = 0; z < 1e12; z++) {}");
    const r = await validateProblemSubmission(base({ verifier: slow }), { verifyFuel: 50 });
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/^good: verifier crashed on good #0: verifier fuel/);
  });

  it("rejects structural problems: too few examples, overlap, missing citation, builtin id, bad author", async () => {
    const r = await validateProblemSubmission(base({ good: [[1, 2]], bad: [[1, 2]], id: "golomb-10", author: "someone", best_known: { score: 12, source: "" } }));
    expect(r.status).toBe("rejected");
    const msg = r.reason!;
    for (const part of ["good: at least 2", "collides with a built-in", "author:", "best_known.source"]) expect(msg).toContain(part);
    expect((await validateProblemSubmission(base({ verifier: "function check(x) { return true }" }))).reason).toMatch(/^static: .*does not declare entry 'verify'/);
  });

  it("rejects a seed program that does not produce a valid solution, and stores the rejection for audit", async () => {
    const res = await submitProblem(E, base({ id: "salem-spencer-bad-seed", seed_program: "function construct(input) { return [1, 2, 3]; }" }));
    expect(res.status).toBe("rejected");
    expect(res.report.reason).toMatch(/^seed:/);
    expect((await getProblemRow(E, "salem-spencer-bad-seed"))!.status).toBe("rejected");
    await expect(stepGeneration(E, null, "salem-spencer-bad-seed", { llm: "off" })).rejects.toThrow(/rejected/);
  });

  it("the built-in problems pass the same validation as submissions (sample of one per family)", async () => {
    const seen = new Set<string>();
    for (const p of builtinProblems()) {
      if (seen.has(p.family)) continue;
      seen.add(p.family);
      const r = await validateProblemSubmission(
        { ...p, id: `check-${p.id}`, good: p.examples.good, bad: p.examples.bad, author: "system:test", best_known: { ...p.best_known } },
        { verifyFuel: p.limits?.verifyFuel ?? 300 },
      );
      expect(r.reason, p.id).toBeUndefined();
    }
    expect(seen.size).toBe(7);
  });
});
