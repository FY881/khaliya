import { describe, expect, it } from "vitest";
import { evaluateProgram } from "../../src/discovery/evolve";
import { mockProgramBrain } from "../../src/discovery/mockProgramBrain";
import { crossover, extractProgram, findKnobs, mutationPrompt, programProblems, topLevelFunctions, tweak } from "../../src/discovery/mutate";
import { builtinProblems, getBuiltinProblem } from "../../src/discovery/problems";
import { mulberry32 } from "../../src/evolution/bandit";

describe("seed programs", () => {
  it("every built-in seed program constructs a valid (naive) solution inside its fuel budget", async () => {
    for (const p of builtinProblems()) {
      const ev = await evaluateProgram(p, p.seed_program, { seed: 1 });
      expect(ev.valid, `${p.id}: ${ev.error}`).toBe(true);
      expect(Number.isFinite(ev.score)).toBe(true);
      // naive seeds never reach a proven optimum (otherwise there is nothing to evolve)
      if (p.best_known.status === "proven_optimal" && p.best_known.score !== null) expect(Math.abs(ev.score! - p.best_known.score), p.id).toBeGreaterThan(1e-9);
    }
  });

  it("knob changes reach much better solutions (the search space is real)", async () => {
    const g = getBuiltinProblem("golomb-10")!;
    const seed = await evaluateProgram(g, g.seed_program);
    const base2 = await evaluateProgram(g, g.seed_program.replace("var BASE = 3;", "var BASE = 2;"));
    const greedy = await evaluateProgram(g, g.seed_program.replace("var USE_GREEDY = 0;", "var USE_GREEDY = 1;"));
    expect(seed.score).toBe(9841); // gaps 1,3,9,... (3^9 − 1)/2
    expect(base2.score).toBe(511);
    expect(greedy.score).toBe(80); // greedy ruler 0 1 3 7 12 20 30 44 65 80
    const f = getBuiltinProblem("clinics-2026-k5")!;
    const ls = await evaluateProgram(f, f.seed_program.replace("var SWEEPS = 0;", "var SWEEPS = 3;"), { constructFuel: 2000 });
    expect(ls.valid).toBe(true);
    expect(ls.score!).toBeLessThan((await evaluateProgram(f, f.seed_program)).score!);
  });

  it("garbage programs are contained: syntax errors, throws, infinite loops, missing construct", async () => {
    const g = getBuiltinProblem("golomb-10")!;
    expect((await evaluateProgram(g, "function construct( {")).error).toMatch(/construct syntax/);
    expect((await evaluateProgram(g, "function construct(){ throw new Error('x') }")).error).toMatch(/construct throw/);
    expect((await evaluateProgram(g, "function construct(){ for(;;){} }", { constructFuel: 30 })).error).toMatch(/construct fuel/);
    expect((await evaluateProgram(g, "var x = 1;")).error).toMatch(/does not declare construct/);
    expect((await evaluateProgram(g, "function construct(){ return 'nope' }")).valid).toBe(false);
  });
});

describe("mutation operators", () => {
  const code = `var A = 3;\nvar B_2 = 0.5;\nvar FLAG = 0;\n\nfunction helper(x) {\n  return x + 1; // }\n}\n\nfunction construct(input) {\n  var s = "{";\n  return [helper(A), B_2, FLAG, s];\n}`;

  it("finds knobs and tweaks exactly one of them deterministically", () => {
    expect(findKnobs(code).map((k) => [k.name, k.value])).toEqual([
      ["A", 3],
      ["B_2", 0.5],
      ["FLAG", 0],
    ]);
    const a = tweak(code, mulberry32(5))!;
    const b = tweak(code, mulberry32(5))!;
    expect(a).toEqual(b);
    expect(a.code).not.toBe(code);
    const changed = findKnobs(a.code).filter((k, i) => k.raw !== findKnobs(code)[i].raw);
    expect(changed.length).toBe(1);
    expect(programProblems(a.code)).toEqual([]);
  });

  it("parses top-level functions with braces in strings/comments and swaps them in crossover", () => {
    const fns = topLevelFunctions(code);
    expect(fns.map((f) => f.name)).toEqual(["helper", "construct"]);
    expect(fns[0].text.endsWith("}")).toBe(true);
    const other = code.replace("return x + 1;", "return x * 2;");
    const x = crossover(code, other, mulberry32(1))!;
    expect(x.note).toBe("function helper from second parent");
    expect(x.code).toContain("return x * 2;");
    // identical functions → knob crossover
    const knobs = crossover(code, code.replace("var A = 3;", "var A = 7;"), mulberry32(2))!;
    expect(knobs.code).toContain("var A = 7;");
    expect(crossover(code, code, mulberry32(3))).toBeNull();
  });

  it("LLM prompt + program extraction + the deterministic mock researcher", () => {
    const p = getBuiltinProblem("sidon-100")!;
    const prompt = mutationPrompt(p, { code: p.seed_program, score: 7 }, [{ code: p.seed_program.replace("var STEP = 5;", "var STEP = 2;"), score: 9 }], 12);
    expect(prompt.user).toMatch(/^MODE: mutate_program/);
    expect(prompt.user).toContain("BEST KNOWN SCORE (literature): 12");
    expect(prompt.system).toMatch(/```js/);
    const reply = mockProgramBrain(prompt.user);
    const prog = extractProgram(reply)!;
    expect(prog).toContain("function construct");
    expect(prog).toMatch(/var STEP = /);
    expect(mockProgramBrain(prompt.user)).toBe(reply); // deterministic
    expect(extractProgram("no code here")).toBeNull();
    expect(extractProgram("```js\nvar x = 1;\n```")).toBeNull();
    expect(extractProgram("```\nfunction construct(i){return 1}\n```\nthen\n```javascript\nfunction construct(i){return 2}\n```")).toBe("function construct(i){return 2}");
  });
});
