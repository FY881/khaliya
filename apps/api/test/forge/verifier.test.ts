import { describe, expect, it } from "vitest";
import { runVerifier, verifierHash } from "../../src/forge/tool";
import { GOLOMB_VERIFIER } from "./fixtures";

describe("verifier runner (Discovery Lab)", () => {
  it("Golomb ruler: accepts the optimal order-5 ruler with its length as score", async () => {
    const r = await runVerifier(GOLOMB_VERIFIER, [0, 1, 4, 9, 11], { instance: { order: 5 } });
    expect(r).toMatchObject({ valid: true, score: 11, detail: "length 11" });
    expect(r.verifierHash).toBe(await verifierHash(GOLOMB_VERIFIER));
    // order 6 optimum (length 17), unsorted input
    expect(await runVerifier(GOLOMB_VERIFIER, [17, 0, 1, 4, 10, 12], { instance: { order: 6 } })).toMatchObject({ valid: true, score: 17 });
  });

  it("Golomb ruler: rejects repeated differences, wrong order and junk", async () => {
    expect(await runVerifier(GOLOMB_VERIFIER, [0, 1, 2, 4], {})).toMatchObject({ valid: false, score: 0, detail: "repeated difference 1" });
    expect((await runVerifier(GOLOMB_VERIFIER, [0, 1, 4, 9, 11], { instance: { order: 6 } })).detail).toMatch(/expected 6 marks/);
    expect((await runVerifier(GOLOMB_VERIFIER, "0,1,4", {})).valid).toBe(false);
    expect((await runVerifier(GOLOMB_VERIFIER, [0, 1.5, 4], {})).valid).toBe(false);
  });

  it("boolean verifiers, crashing verifiers, looping verifiers and bad replies", async () => {
    expect(await runVerifier("function verify(x){ return x.solution === 42 }", 42)).toMatchObject({ valid: true, score: 1 });
    expect(await runVerifier("function verify(x){ return x.solution === 42 }", 41)).toMatchObject({ valid: false, score: 0 });
    const crash = await runVerifier("function verify(x){ return x.solution.nope.deeper }", 1);
    expect(crash).toMatchObject({ valid: false, errorKind: "throw" });
    const loop = await runVerifier("function verify(){ for(;;){} }", 1, { limits: { fuel: 50 } });
    expect(loop).toMatchObject({ valid: false, errorKind: "fuel" });
    expect(await runVerifier("function verify(){ return 'yes' }", 1)).toMatchObject({ valid: false, errorKind: "bad_result" });
    expect(await runVerifier("function verify(){ return { valid: true, score: Infinity } }", 1)).toMatchObject({ valid: true, score: 1 });
  });

  it("is reproducible: same verifier + same solution ⇒ same verdict", async () => {
    const code = "function verify(x){ var s = 0; for (var i = 0; i < 5; i++) s += rand(); return { valid: true, score: s } }";
    const a = await runVerifier(code, null, { seed: 9 });
    const b = await runVerifier(code, null, { seed: 9 });
    expect(a.score).toBe(b.score);
  });
});
