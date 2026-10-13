import { describe, expect, it } from "vitest";
import { runVerifier } from "../../src/forge/tool";
import {
  builtinProblems,
  bipartite,
  CAPSET_VERIFIER,
  circulant,
  cityCost,
  FACILITY_OPTIMA,
  FACILITY_VERIFIER,
  fibonacciSphere,
  generateCity,
  getBuiltinProblem,
  GOLOMB_OPTIMAL,
  GOLOMB_OPTIMAL_RULERS,
  GOLOMB_VERIFIER,
  icosahedron,
  paley,
  RAMSEY_VERIFIER,
  SIDON_VERIFIER,
  SQUARE_VERIFIER,
  TAMMES_VERIFIER,
} from "../../src/discovery/problems";

const V = (code: string, solution: unknown, instance: unknown, fuel = 400) => runVerifier(code, solution, { instance, limits: { fuel } });

describe("Discovery verifiers: known good / known bad", () => {
  it("Golomb: {0,1,4,9,11} is a valid order-5 ruler of length 11; repeated differences are invalid", async () => {
    expect(await V(GOLOMB_VERIFIER, [0, 1, 4, 9, 11], { n: 5 })).toMatchObject({ valid: true, score: 11, detail: "length 11" });
    expect(await V(GOLOMB_VERIFIER, [11, 9, 4, 1, 0], { n: 5 })).toMatchObject({ valid: true, score: 11 });
    expect(await V(GOLOMB_VERIFIER, [0, 1, 2, 4, 9], { n: 5 })).toMatchObject({ valid: false, detail: "repeated difference 1" });
    expect(await V(GOLOMB_VERIFIER, [0, 1, 4, 9], { n: 5 })).toMatchObject({ valid: false });
    expect(await V(GOLOMB_VERIFIER, [0, 1, 1, 4, 9], { n: 5 })).toMatchObject({ valid: false, detail: "duplicate mark 1" });
    for (const n of [10, 11, 12, 13, 14]) {
      const r = await V(GOLOMB_VERIFIER, GOLOMB_OPTIMAL_RULERS[n], { n });
      expect(r, `optimal ruler n=${n}`).toMatchObject({ valid: true, score: GOLOMB_OPTIMAL[n] });
    }
  });

  it("Sidon: optimal 12-set in [1..100] and 17-set in [1..200]; repeated sums invalid", async () => {
    const s100 = GOLOMB_OPTIMAL_RULERS[12].map((m) => m + 1);
    expect(await V(SIDON_VERIFIER, s100, { N: 100 })).toMatchObject({ valid: true, score: 12 });
    expect(await V(SIDON_VERIFIER, [1, 2, 3, 4], { N: 100 })).toMatchObject({ valid: false, detail: "repeated sum 4" });
    expect(await V(SIDON_VERIFIER, [1, 2, 5, 101], { N: 100 })).toMatchObject({ valid: false });
    expect(await V(SIDON_VERIFIER, [], { N: 100 })).toMatchObject({ valid: true, score: 0 });
    expect(getBuiltinProblem("sidon-100")!.best_known.score).toBe(12);
    expect(getBuiltinProblem("sidon-200")!.best_known.score).toBe(17);
  });

  it("Cap set: {0,1}^4 (16 points) is a cap; a line is not", async () => {
    const cube: number[][] = [];
    for (let i = 0; i < 16; i++) cube.push([(i >> 3) & 1, (i >> 2) & 1, (i >> 1) & 1, i & 1]);
    expect(await V(CAPSET_VERIFIER, cube, { n: 4 })).toMatchObject({ valid: true, score: 16 });
    expect(await V(CAPSET_VERIFIER, [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2]], { n: 4 })).toMatchObject({ valid: false });
    expect(await V(CAPSET_VERIFIER, [[0, 0, 0, 3]], { n: 4 })).toMatchObject({ valid: false });
    // a known maximal cap of size 4 in F_3^2 (best known = 4)
    expect(await V(CAPSET_VERIFIER, [[0, 0], [0, 1], [1, 0], [1, 1]], { n: 2 })).toMatchObject({ valid: true, score: 4 });
  });

  it("Points in a square: 4×4 grid reaches the optimum 1/3 for N=16; outside points invalid", async () => {
    const grid = Array.from({ length: 16 }, (_, i) => [(i % 4) / 3, Math.floor(i / 4) / 3]);
    const r = await V(SQUARE_VERIFIER, grid, { N: 16 });
    expect(r.valid).toBe(true);
    expect(r.score).toBeCloseTo(1 / 3, 12);
    expect((await V(SQUARE_VERIFIER, [...grid.slice(0, 15), [1.01, 0]], { N: 16 })).valid).toBe(false);
    expect((await V(SQUARE_VERIFIER, [...grid.slice(0, 15), [0, 0]], { N: 16 })).valid).toBe(false);
    expect((await V(SQUARE_VERIFIER, grid.slice(0, 15), { N: 16 })).valid).toBe(false);
  });

  it("Tammes: the icosahedron gives 63.4349488° for N=12; zero vectors invalid", async () => {
    const r = await V(TAMMES_VERIFIER, icosahedron(), { N: 12 });
    expect(r.valid).toBe(true);
    expect(r.score).toBeCloseTo((Math.atan(2) * 180) / Math.PI, 9);
    expect(Math.abs(r.score - getBuiltinProblem("tammes-12")!.best_known.score!)).toBeLessThan(1e-9);
    expect((await V(TAMMES_VERIFIER, [...fibonacciSphere(11), [0, 0, 0]], { N: 12 })).valid).toBe(false);
  });

  it("Ramsey: Paley(17) is a (4,4) colouring of K17; C13(1,5) is a (3,5) colouring; monochromatic cliques invalid", async () => {
    expect(await V(RAMSEY_VERIFIER, paley(17), { s: 4, t: 4 }, 800)).toMatchObject({ valid: true, score: 17 });
    expect(await V(RAMSEY_VERIFIER, circulant(13, [1, 5]), { s: 3, t: 5 }, 800)).toMatchObject({ valid: true, score: 13 });
    expect(await V(RAMSEY_VERIFIER, paley(37), { s: 5, t: 5 }, 800)).toMatchObject({ valid: true, score: 37 });
    expect((await V(RAMSEY_VERIFIER, paley(17), { s: 3, t: 5 }, 800)).detail).toMatch(/red K3/);
    expect((await V(RAMSEY_VERIFIER, bipartite(8), { s: 4, t: 4 }, 800)).detail).toMatch(/blue K4/);
    expect((await V(RAMSEY_VERIFIER, ["01", "00"], { s: 3, t: 3 })).detail).toMatch(/symmetric/);
  });

  it("Facility location: the stored exhaustive optimum re-verifies exactly; duplicates invalid", async () => {
    const p = getBuiltinProblem("clinics-2026-k5")!;
    const opt = FACILITY_OPTIMA[202605];
    const r = await V(FACILITY_VERIFIER, opt.choice, p.instance);
    expect(r.valid).toBe(true);
    expect(r.score).toBe(opt.score);
    expect(r.score).toBe(cityCost(generateCity(2026, 240, 36, 5), opt.choice));
    expect(p.best_known).toMatchObject({ score: opt.score, status: "computed" });
    // every other choice of 5 tested here is worse than the optimum
    const naive = await V(FACILITY_VERIFIER, [0, 1, 2, 3, 4], p.instance);
    expect(naive.score).toBeGreaterThan(opt.score);
    expect((await V(FACILITY_VERIFIER, [1, 1, 2, 3, 4], p.instance)).valid).toBe(false);
  });

  it("every built-in problem: goods valid with finite scores, bads rejected cleanly (no crash), best-known cited", async () => {
    const all = builtinProblems();
    expect(all.length).toBeGreaterThanOrEqual(20);
    for (const p of all) {
      expect(p.best_known.source.length, p.id).toBeGreaterThan(10);
      for (const g of p.examples.good) {
        const r = await runVerifier(p.verifier, g, { instance: p.instance, limits: { fuel: p.limits?.verifyFuel ?? 300 } });
        expect(r.valid, `${p.id} good: ${r.detail}`).toBe(true);
        expect(Number.isFinite(r.score)).toBe(true);
        // a good example never beats a proven optimum
        if (p.best_known.status === "proven_optimal" && p.best_known.score !== null)
          expect(p.direction === "max" ? r.score <= p.best_known.score + 1e-9 : r.score >= p.best_known.score - 1e-9, `${p.id} good beats a proven optimum?`).toBe(true);
      }
      for (const b of p.examples.bad) {
        const r = await runVerifier(p.verifier, b, { instance: p.instance, limits: { fuel: p.limits?.verifyFuel ?? 300 } });
        expect(r.valid, `${p.id} bad accepted: ${JSON.stringify(b).slice(0, 60)}`).toBe(false);
        expect(r.errorKind, `${p.id} bad crashed: ${r.detail}`).toBeUndefined();
      }
    }
  });
});
