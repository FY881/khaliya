import { describe, expect, it } from "vitest";
import { conservative, newPlayer, update, wilsonLower, winRate } from "../../src/evolution/rating";
import { hashSeed, mulberry32, sampleBeta, sampleGamma, ThompsonBandit } from "../../src/evolution/bandit";
import { canaryRoute, promotionGate, shouldRollback } from "../../src/evolution/gate";

describe("glicko-2", () => {
  it("matches Glickman's worked example", () => {
    const p = update({ r: 1500, rd: 200, vol: 0.06 }, [
      { opp: { r: 1400, rd: 30 }, score: 1 },
      { opp: { r: 1550, rd: 100 }, score: 0 },
      { opp: { r: 1700, rd: 300 }, score: 0 },
    ]);
    expect(p.r).toBeCloseTo(1464.06, 1);
    expect(p.rd).toBeCloseTo(151.52, 1);
    expect(p.vol).toBeCloseTo(0.05999, 4);
  });
  it("defaults to 1500/350/0.06", () => {
    expect(newPlayer()).toEqual({ r: 1500, rd: 350, vol: 0.06 });
  });
  it("no games: rating unchanged, RD grows but capped at 350", () => {
    const p = update({ r: 1600, rd: 50, vol: 0.06 }, []);
    expect(p.r).toBe(1600);
    expect(p.rd).toBeGreaterThan(50);
    expect(update(newPlayer(), []).rd).toBe(350);
  });
  it("win raises, loss lowers, draw vs equal ~ unchanged; RD shrinks", () => {
    const opp = { r: 1500, rd: 100 };
    const w = update(newPlayer(), [{ opp, score: 1 }]);
    const l = update(newPlayer(), [{ opp, score: 0 }]);
    const d = update(newPlayer(), [{ opp, score: 0.5 }]);
    expect(w.r).toBeGreaterThan(1500);
    expect(l.r).toBeLessThan(1500);
    expect(d.r).toBeCloseTo(1500, 6);
    expect(w.rd).toBeLessThan(350);
    expect(w.r - 1500).toBeCloseTo(1500 - l.r, 6);
  });
  it("is pure (does not mutate input)", () => {
    const p = { r: 1500, rd: 200, vol: 0.06 };
    update(p, [{ opp: { r: 1400, rd: 30 }, score: 1 }]);
    expect(p).toEqual({ r: 1500, rd: 200, vol: 0.06 });
  });
  it("conservative = r - 2rd", () => {
    expect(conservative({ r: 1500, rd: 100 })).toBe(1300);
  });
  it("wilsonLower known values and edges", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(8, 8)).toBeCloseTo(0.6756, 3);
    expect(wilsonLower(5, 10)).toBeCloseTo(0.2366, 3);
    expect(wilsonLower(0, 10)).toBe(0);
    expect(wilsonLower(90, 100)).toBeGreaterThan(wilsonLower(9, 10));
  });
  it("winRate counts draws as half", () => {
    expect(winRate(3, 1, 2)).toBeCloseTo(4 / 6);
    expect(winRate(0, 0, 0)).toBe(0);
  });
});

describe("bandit", () => {
  it("mulberry32 deterministic and in [0,1)", () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const xs = Array.from({ length: 1000 }, a);
    expect(Array.from({ length: 1000 }, b)).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
  it("hashSeed stable for strings and numbers", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
    expect(hashSeed(7)).toBe(7);
  });
  it("gamma/beta sample means are right (incl. shape<1)", () => {
    const rng = mulberry32(1);
    const N = 20000;
    for (const k of [0.5, 1, 3.5]) {
      let s = 0;
      for (let i = 0; i < N; i++) s += sampleGamma(k, rng);
      expect(s / N).toBeCloseTo(k, 1);
    }
    let s = 0;
    for (let i = 0; i < N; i++) s += sampleBeta(2, 6, rng);
    expect(s / N).toBeCloseTo(0.25, 2);
    expect(() => sampleGamma(0, rng)).toThrow();
  });
  it("choose is deterministic for a seed and state", () => {
    const mk = () => {
      const b = new ThompsonBandit(["a", "b", "c"]);
      b.update("a", true); b.update("b", false); b.update("c", true); b.update("c", true);
      return b;
    };
    const b1 = mk(), b2 = mk();
    for (let s = 0; s < 50; s++) expect(b1.choose(s)).toBe(b2.choose(s));
    expect(b1.choose("run-1")).toBe(b2.choose("run-1"));
    // arm insertion order must not matter
    const b3 = ThompsonBandit.fromJSON({ prior: { alpha: 1, beta: 1 }, arms: { c: b1.get("c")!, b: b1.get("b")!, a: b1.get("a")! } });
    for (let s = 0; s < 50; s++) expect(b3.choose(s)).toBe(b1.choose(s));
  });
  it("converges to the best arm", () => {
    const p: Record<string, number> = { a: 0.2, b: 0.5, c: 0.8 };
    const env = mulberry32(99);
    const b = new ThompsonBandit(Object.keys(p));
    const picks: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let t = 0; t < 2000; t++) {
      const arm = b.choose(t);
      if (t >= 1000) picks[arm]!++;
      b.update(arm, env() < p[arm]!);
    }
    expect(picks.c! / 1000).toBeGreaterThan(0.9);
    expect(b.mean("c")).toBeCloseTo(0.8, 1);
  });
  it("decay shrinks toward prior; 0 resets, 1 no-op; validates", () => {
    const b = new ThompsonBandit(["x"]);
    for (let i = 0; i < 10; i++) b.update("x", true);
    b.decay(1);
    expect(b.get("x")).toEqual({ alpha: 11, beta: 1 });
    b.decay(0.5);
    expect(b.get("x")).toEqual({ alpha: 6, beta: 1 });
    b.decay(0);
    expect(b.get("x")).toEqual({ alpha: 1, beta: 1 });
    expect(() => b.decay(1.5)).toThrow();
  });
  it("toJSON/fromJSON round-trips; update adds unknown arms; empty throws", () => {
    const b = new ThompsonBandit(["a"], { alpha: 2, beta: 3 });
    b.update("new", true);
    const j = JSON.parse(JSON.stringify(b));
    expect(j).toEqual({ prior: { alpha: 2, beta: 3 }, arms: { a: { alpha: 2, beta: 3 }, new: { alpha: 3, beta: 3 } } });
    const r = ThompsonBandit.fromJSON(j);
    expect(r.toJSON()).toEqual(j);
    expect(r.choose(5)).toBe(b.choose(5));
    expect(() => new ThompsonBandit().choose(1)).toThrow();
    expect(() => ThompsonBandit.fromJSON({ prior: { alpha: 1, beta: 1 }, arms: { z: { alpha: 0, beta: 1 } } })).toThrow();
  });
});

describe("promotion gate", () => {
  const base = { wins: 8, losses: 0, draws: 0, safetyCandidate: 1, safetyChampion: 1, costCandidate: 1, costChampion: 1 };
  it("passes a clear winner", () => {
    const r = promotionGate(base);
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
  });
  it("rejects too few matches", () => {
    const r = promotionGate({ ...base, wins: 7 });
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toMatch(/too few/);
  });
  it("high win rate but Wilson lower <= 0.5 fails", () => {
    const r = promotionGate({ ...base, wins: 6, losses: 2 }); // 75%, wilson ~0.41
    expect(r.winRate).toBe(0.75);
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toMatch(/wilson/);
  });
  it("draws count half", () => {
    const r = promotionGate({ ...base, wins: 0, draws: 40 });
    expect(r.winRate).toBe(0.5);
    expect(r.pass).toBe(false);
    const big = promotionGate({ ...base, wins: 60, losses: 20, draws: 20 }); // 70%
    expect(big.winRate).toBe(0.7);
    expect(big.pass).toBe(true);
  });
  it("any safety regression fails, even tiny", () => {
    const r = promotionGate({ ...base, safetyCandidate: 0.999 });
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toMatch(/safety/);
    expect(promotionGate({ ...base, safetyCandidate: 1.2 }).pass).toBe(true);
  });
  it("cost increase boundary at 25%", () => {
    expect(promotionGate({ ...base, costCandidate: 1.25 }).pass).toBe(true);
    expect(promotionGate({ ...base, costCandidate: 1.26 }).pass).toBe(false);
    expect(promotionGate({ ...base, costCandidate: 0.1 }).pass).toBe(true);
    expect(promotionGate({ ...base, costChampion: 0, costCandidate: 0 }).pass).toBe(true);
    expect(promotionGate({ ...base, costChampion: 0, costCandidate: 0.01 }).pass).toBe(false);
  });
  it("respects custom options and collects multiple reasons", () => {
    expect(promotionGate({ ...base, costCandidate: 1.4 }, { maxCostIncrease: 0.5 }).pass).toBe(true);
    const r = promotionGate({ ...base, wins: 1, losses: 3, safetyCandidate: 0, costCandidate: 9 });
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
  it("rejects negative counts", () => {
    expect(promotionGate({ ...base, losses: -1 }).pass).toBe(false);
  });
});

describe("canary + rollback", () => {
  it("canaryRoute deterministic and ~pct", () => {
    expect(canaryRoute("req-1")).toBe(canaryRoute("req-1"));
    let hits = 0;
    for (let i = 0; i < 10000; i++) if (canaryRoute(`req-${i}`)) hits++;
    expect(hits / 10000).toBeGreaterThan(0.08);
    expect(hits / 10000).toBeLessThan(0.12);
    expect(canaryRoute(1, 0)).toBe(false);
    expect(canaryRoute(1, 1)).toBe(true);
  });
  it("shouldRollback respects minN and maxDrop", () => {
    expect(shouldRollback({ canaryScore: 0.1, championScore: 0.9, n: 4 })).toBe(false);
    expect(shouldRollback({ canaryScore: 0.1, championScore: 0.9, n: 5 })).toBe(true);
    expect(shouldRollback({ canaryScore: 0.86, championScore: 0.9, n: 50 })).toBe(false);
    expect(shouldRollback({ canaryScore: 0.84, championScore: 0.9, n: 50 })).toBe(true);
    expect(shouldRollback({ canaryScore: 0.95, championScore: 0.9, n: 50 })).toBe(false);
    expect(shouldRollback({ canaryScore: 0.7, championScore: 0.9, n: 3, minN: 2, maxDrop: 0.3 })).toBe(false);
    expect(shouldRollback({ canaryScore: NaN, championScore: 0.9, n: 10 })).toBe(true);
  });
});
