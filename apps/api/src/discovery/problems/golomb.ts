/**
 * Golomb rulers: n integer marks, all pairwise differences distinct; minimise the length (max − min).
 * Best known = optimal lengths, OEIS A003022 (b-file fetched 2026-10-12): 10→55, 11→72, 12→85, 13→106, 14→127.
 */
import type { ProblemDef } from "../types";

export const GOLOMB_OPTIMAL: Record<number, number> = { 2: 1, 3: 3, 4: 6, 5: 11, 6: 17, 7: 25, 8: 34, 9: 44, 10: 55, 11: 72, 12: 85, 13: 106, 14: 127, 15: 151, 16: 177, 17: 199, 18: 216 };

/** Optimal rulers (Wikipedia "Golomb ruler" table; each is re-checked by the verifier in the tests). */
export const GOLOMB_OPTIMAL_RULERS: Record<number, number[]> = {
  10: [0, 1, 6, 10, 23, 26, 34, 41, 53, 55],
  11: [0, 1, 4, 13, 28, 33, 47, 54, 64, 70, 72],
  12: [0, 2, 6, 24, 29, 40, 43, 55, 68, 75, 76, 85],
  13: [0, 2, 5, 25, 37, 43, 59, 70, 85, 89, 98, 99, 106],
  14: [0, 4, 6, 20, 35, 52, 59, 77, 78, 86, 89, 99, 122, 127],
};

export const GOLOMB_VERIFIER = `function verify(x) {
  try {
    var inst = x && x.instance; var n = inst && inst.n; var m = x && x.solution;
    if (typeof n !== "number" || n < 2 || n > 64) return { valid: false, detail: "bad instance" };
    if (!Array.isArray(m)) return { valid: false, detail: "solution must be an array of integer marks" };
    if (m.length !== n) return { valid: false, detail: "expected " + n + " marks, got " + m.length };
    var s = [];
    for (var i = 0; i < n; i++) {
      var v = m[i];
      if (typeof v !== "number" || v !== Math.floor(v) || v < 0 || v > 1000000) return { valid: false, detail: "mark " + i + " is not an integer in [0, 1e6]" };
      s.push(v);
    }
    s.sort(function (a, b) { return a - b; });
    for (var u = 1; u < n; u++) if (s[u] === s[u - 1]) return { valid: false, detail: "duplicate mark " + s[u] };
    var seen = {};
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) {
      var d = s[b] - s[a];
      if (seen[d]) return { valid: false, detail: "repeated difference " + d };
      seen[d] = 1;
    }
    var L = s[n - 1] - s[0];
    return { valid: true, score: L, detail: "length " + L };
  } catch (e) { return { valid: false, detail: "malformed solution" }; }
}`;

export const GOLOMB_SEED = `// Naive Golomb ruler constructor. Knobs (var NAME = number) are tuned by the evolution engine.
var BASE = 3;        // geometric marks: gaps 1, BASE, BASE^2, ... (a valid ruler for any integer BASE >= 2)
var USE_GREEDY = 0;  // >= 1: switch to a greedy search instead
var JITTER = 0.0;    // greedy: probability of skipping a feasible mark (randomised greedy)
var TRIES = 1;       // greedy: best of TRIES randomised runs

function geometric(n) {
  var marks = [0], gap = 1;
  for (var i = 1; i < n; i++) { marks.push(marks[i - 1] + gap); gap = gap * BASE; }
  return marks;
}

function greedy(n) {
  var marks = [0], used = {}, x = 1;
  while (marks.length < n && x < 100000) {
    var ok = true;
    for (var i = 0; i < marks.length; i++) if (used[x - marks[i]]) { ok = false; break; }
    if (ok && rand() >= JITTER) {
      for (var j = 0; j < marks.length; j++) used[x - marks[j]] = 1;
      marks.push(x);
    }
    x++;
  }
  return marks;
}

function construct(input) {
  var n = input.n;
  if (USE_GREEDY < 1) return geometric(n);
  var best = null;
  for (var t = 0; t < Math.max(1, TRIES); t++) {
    var r = greedy(n);
    if (!best || r[r.length - 1] < best[best.length - 1]) best = r;
  }
  return best;
}`;

/** Mian–Chowla-style greedy ruler (valid, far from optimal). */
export function greedyRuler(n: number): number[] {
  const marks = [0];
  const used = new Set<number>();
  for (let x = 1; marks.length < n; x++) {
    if (marks.some((m) => used.has(x - m))) continue;
    for (const m of marks) used.add(x - m);
    marks.push(x);
  }
  return marks;
}

export function golombProblem(n: number): ProblemDef {
  const opt = GOLOMB_OPTIMAL[n] ?? null;
  const good: unknown[] = [greedyRuler(n), [...(GOLOMB_OPTIMAL_RULERS[n] ?? greedyRuler(n))].reverse()];
  return {
    id: `golomb-${n}`,
    family: "golomb",
    title_en: `Golomb ruler with ${n} marks`,
    title_ar: `مسطرة جولومب ذات ${n} علامة`,
    statement_en: `Place ${n} integer marks on a ruler so that every pair of marks is a different distance apart. Make the ruler as short as possible (length = largest mark − smallest mark).`,
    statement_ar: `ضع ${n} علامة صحيحة على مسطرة بحيث تكون المسافة بين كل زوج من العلامات مختلفة عن غيرها، واجعل المسطرة أقصر ما يمكن (الطول = أكبر علامة − أصغر علامة).`,
    direction: "min",
    params: { n },
    instance: { n },
    verifier: GOLOMB_VERIFIER,
    seed_program: GOLOMB_SEED,
    best_known: {
      score: opt,
      status: opt === null ? "unverified" : "proven_optimal",
      source: "OEIS A003022 (lengths of optimal Golomb rulers), https://oeis.org/A003022 ; see also https://en.wikipedia.org/wiki/Golomb_ruler (optimality for n ≤ 14 established by exhaustive search; n ≤ 28 by distributed.net/OGR projects).",
    },
    examples: {
      good,
      bad: [
        [0, 1, 2, ...greedyRuler(n).slice(3)], // repeated difference 1
        greedyRuler(n - 1), // wrong number of marks
        [...greedyRuler(n - 1), 0.5], // non-integer mark
        [...greedyRuler(n - 1), greedyRuler(n - 1)[1]], // duplicate mark
      ],
    },
    describe: (sol) => {
      const s = (sol as number[]).slice().sort((a, b) => a - b);
      const L = s[s.length - 1] - s[0] || 1;
      return Math.min(0.999, Math.max(0, (s[Math.floor(s.length / 2)] - s[0]) / L));
    },
    limits: { constructFuel: 400, verifyFuel: 200 },
  };
}
