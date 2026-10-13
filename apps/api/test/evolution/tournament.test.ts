import { describe, expect, it } from "vitest";
import { newPlayer, update } from "../../src/evolution/rating";
import { aggregate, headToHead, schedule, type MatchResult } from "../../src/evolution/tournament";

const items = ["i1", "i2", "i3", "i4"];

describe("schedule", () => {
  it("plays every pairing twice with positions swapped", () => {
    const ms = schedule("cand", "champ", ["p1", "p2"], items, { seed: 1 });
    expect(ms).toHaveLength(items.length * 3 * 2);
    const byPair = new Map<string, typeof ms>();
    for (const m of ms) byPair.set(m.pairKey, [...(byPair.get(m.pairKey) ?? []), m]);
    expect(byPair.size).toBe(12);
    for (const [, pair] of byPair) {
      expect(pair).toHaveLength(2);
      const [x, y] = pair;
      expect(x!.a).toBe(y!.b);
      expect(x!.b).toBe(y!.a);
      expect(x!.itemId).toBe(y!.itemId);
      expect(new Set(pair.map((m) => m.swapped))).toEqual(new Set([true, false]));
      for (const m of pair) expect(m.swapped ? m.b : m.a).toBe("cand");
    }
    expect(new Set(ms.map((m) => m.id)).size).toBe(ms.length);
    // swapped pairs are adjacent
    for (let i = 0; i < ms.length; i += 2) expect(ms[i]!.pairKey).toBe(ms[i + 1]!.pairKey);
  });
  it("is deterministic per seed and varies across seeds", () => {
    const a = schedule("cand", "champ", ["p1", "p2"], items, { seed: "s" });
    const b = schedule("cand", "champ", ["p2", "p1", "p1"], [...items].reverse(), { seed: "s" });
    expect(a).toEqual(b);
    const orders = new Set([1, 2, 3, 4, 5, 6].map((s) => schedule("cand", "champ", ["p1"], items, { seed: s }).map((m) => m.id).join()));
    expect(orders.size).toBeGreaterThan(1);
  });
  it("excludes items authored by the candidate's lineage", () => {
    const ms = schedule("cand", "champ", [], items, {
      seed: 1,
      excludeAuthoredByLineage: "builder",
      authorsByItem: { i1: "builder", i2: "researcher" },
    });
    const used = new Set(ms.map((m) => m.itemId));
    expect(used.has("i1")).toBe(false);
    expect(used).toEqual(new Set(["i2", "i3", "i4"]));
    const multi = schedule("cand", "champ", [], items, {
      excludeAuthoredByLineage: ["builder", "researcher"],
      authorsByItem: { i1: "builder", i2: "researcher" },
    });
    expect(new Set(multi.map((m) => m.itemId))).toEqual(new Set(["i3", "i4"]));
  });
  it("never pairs the candidate with itself and dedupes champion from peers", () => {
    const ms = schedule("cand", "champ", ["cand", "champ", "p1"], ["i1"], { seed: 1 });
    expect(ms).toHaveLength(4);
    for (const m of ms) expect(m.a).not.toBe(m.b);
    expect(schedule("cand", "cand", [], ["i1"])).toHaveLength(0);
    expect(schedule("cand", null, ["p1"], ["i1"])).toHaveLength(2);
  });
  it("maxMatches caps in whole pairs, champion pairs first, peers spread across items", () => {
    const ms = schedule("cand", "champ", ["p1", "p2", "p3"], items, { seed: 7, maxMatches: 15 });
    expect(ms).toHaveLength(14);
    const opps = ms.map((m) => (m.a === "cand" ? m.b : m.a));
    expect(opps.slice(0, 8).every((o) => o === "champ")).toBe(true);
    const peerOpps = opps.slice(8);
    expect(new Set(peerOpps).size).toBe(3); // 3 peer pairs → all 3 distinct peers
    expect(schedule("cand", "champ", ["p1"], items, { maxMatches: 1 })).toHaveLength(0);
    expect(schedule("cand", "champ", ["p1"], items, { maxMatches: 0 })).toHaveLength(0);
  });
});

describe("aggregate", () => {
  it("updates ratings and W/L/D", () => {
    const res: MatchResult[] = [
      { a: "cand", b: "champ", score: 1, pairKey: "k1" },
      { a: "champ", b: "cand", score: 0, pairKey: "k1" },
      { a: "cand", b: "p1", score: 0.5, pairKey: "k2" },
      { a: "p1", b: "cand", score: 0.5, pairKey: "k2" },
    ];
    const out = aggregate(res, { champ: { r: 1600, rd: 80, vol: 0.06 } });
    expect(out.records.cand).toEqual({ wins: 2, losses: 0, draws: 2, games: 4 });
    expect(out.records.champ).toEqual({ wins: 0, losses: 2, draws: 0, games: 2 });
    expect(out.records.p1).toEqual({ wins: 0, losses: 0, draws: 2, games: 2 });
    expect(out.ratings.cand!.r).toBeGreaterThan(1500);
    expect(out.ratings.champ!.r).toBeLessThan(1600);
    expect(out.ratings.cand!.rd).toBeLessThan(350);
    expect(out.inconsistentPairs).toEqual([]);
  });
  it("matches rating.update with pre-period opponent ratings (order independent)", () => {
    const ratings = { a: { r: 1500, rd: 200, vol: 0.06 }, b: { r: 1400, rd: 30, vol: 0.06 }, c: { r: 1550, rd: 100, vol: 0.06 }, d: { r: 1700, rd: 300, vol: 0.06 } };
    const res: MatchResult[] = [
      { a: "a", b: "b", score: 1 },
      { a: "c", b: "a", score: 1 },
      { a: "a", b: "d", score: 0 },
    ];
    const out = aggregate(res, ratings);
    // Glickman's worked example
    expect(out.ratings.a!.r).toBeCloseTo(1464.06, 1);
    expect(out.ratings.a!.rd).toBeCloseTo(151.52, 1);
    const expectedB = update(ratings.b, [{ opp: { r: 1500, rd: 200 }, score: 0 }]);
    expect(out.ratings.b).toEqual(expectedB);
    expect(aggregate([...res].reverse(), ratings).ratings).toEqual(out.ratings);
  });
  it("is pure, leaves idle players unchanged by default, inflates when asked", () => {
    const ratings = { idle: { r: 1600, rd: 50, vol: 0.06 }, x: newPlayer() };
    const snapshot = JSON.parse(JSON.stringify(ratings));
    const out = aggregate([{ a: "x", b: "y", score: 1 }], ratings);
    expect(ratings).toEqual(snapshot);
    expect(out.ratings.idle).toEqual({ r: 1600, rd: 50, vol: 0.06 });
    expect(out.records.idle).toEqual({ wins: 0, losses: 0, draws: 0, games: 0 });
    expect(out.ratings.y).toBeDefined();
    const inf = aggregate([{ a: "x", b: "y", score: 1 }], ratings, { inflateIdle: true });
    expect(inf.ratings.idle!.rd).toBeGreaterThan(50);
  });
  it("ignores invalid results", () => {
    const out = aggregate([
      { a: "x", b: "x", score: 1 },
      { a: "x", b: "y", score: 0.7 as never },
    ]);
    expect(Object.keys(out.ratings)).toEqual([]);
  });
  it("flags position-inconsistent pairs", () => {
    const res: MatchResult[] = [
      { a: "cand", b: "champ", score: 1, pairKey: "k1" }, // A seat wins
      { a: "champ", b: "cand", score: 1, pairKey: "k1" }, // A seat wins again → bias
      { a: "cand", b: "champ", score: 1, pairKey: "k2" },
      { a: "champ", b: "cand", score: 0, pairKey: "k2" },
    ];
    expect(aggregate(res).inconsistentPairs).toEqual(["k1"]);
  });
  it("end-to-end with schedule: a dominant candidate climbs", () => {
    const ms = schedule("cand", "champ", ["p1", "p2"], items, { seed: 3 });
    const res: MatchResult[] = ms.map((m) => ({ a: m.a, b: m.b, score: m.a === "cand" ? 1 : 0, pairKey: m.pairKey }));
    const out = aggregate(res, { champ: { r: 1550, rd: 60, vol: 0.06 } });
    expect(out.records.cand).toEqual({ wins: 24, losses: 0, draws: 0, games: 24 });
    expect(out.ratings.cand!.r).toBeGreaterThan(out.ratings.champ!.r);
    expect(headToHead(res, "cand", ["champ"])).toEqual({ wins: 8, losses: 0, draws: 0, games: 8 });
    expect(headToHead(res, "champ")).toEqual({ wins: 0, losses: 8, draws: 0, games: 8 });
  });
});
