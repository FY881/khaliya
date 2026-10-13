/**
 * Cap sets in F_3^n: no three distinct points on a line (equivalently a+b+c ≡ 0 mod 3 coordinatewise).
 * Maximum sizes 1, 2, 4, 9, 20, 45, 112 for n = 0..6 (OEIS A090245; n=6 by Potechin 2008).
 */
import type { ProblemDef } from "../types";

export const CAPSET_MAX: Record<number, number> = { 1: 2, 2: 4, 3: 9, 4: 20, 5: 45, 6: 112 };

export const CAPSET_VERIFIER = `function verify(x) {
  try {
    var n = x && x.instance && x.instance.n; var pts = x && x.solution;
    if (typeof n !== "number" || n < 1 || n > 8) return { valid: false, detail: "bad instance" };
    if (!Array.isArray(pts)) return { valid: false, detail: "solution must be an array of points (arrays of n digits 0/1/2)" };
    var total = 1; for (var t = 0; t < n; t++) total *= 3;
    if (pts.length > total) return { valid: false, detail: "more points than F_3^n holds" };
    var code = [], inSet = {};
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!Array.isArray(p) || p.length !== n) return { valid: false, detail: "point " + i + " must have " + n + " coordinates" };
      var c = 0;
      for (var k = 0; k < n; k++) {
        var v = p[k];
        if (v !== 0 && v !== 1 && v !== 2) return { valid: false, detail: "point " + i + " has a coordinate outside {0,1,2}" };
        c = c * 3 + v;
      }
      if (inSet[c]) return { valid: false, detail: "duplicate point " + i };
      inSet[c] = 1; code.push(p);
    }
    for (var a = 0; a < code.length; a++) for (var b = a + 1; b < code.length; b++) {
      var r = 0;
      for (var j = 0; j < n; j++) r = r * 3 + ((6 - code[a][j] - code[b][j]) % 3);
      if (inSet[r]) return { valid: false, detail: "points " + a + " and " + b + " complete a line" };
    }
    return { valid: true, score: code.length, detail: "size " + code.length };
  } catch (e) { return { valid: false, detail: "malformed solution" }; }
}`;

export const CAPSET_SEED = `// Naive cap-set constructor: greedy over points in a (possibly shuffled) order, keep a point if it closes no line.
var SHUFFLE = 0;  // >= 1: visit points in random order
var TRIES = 1;    // best of TRIES greedy runs
var OFFSET = 0;   // start the scan at this point index

function pointOf(c, n) { var p = []; for (var i = 0; i < n; i++) { p.unshift(c % 3); c = Math.floor(c / 3); } return p; }

function third(a, b, n) {
  var r = 0, pa = pointOf(a, n), pb = pointOf(b, n);
  for (var j = 0; j < n; j++) r = r * 3 + ((6 - pa[j] - pb[j]) % 3);
  return r;
}

function greedy(n) {
  var total = Math.pow(3, n), order = [];
  for (var c = 0; c < total; c++) order.push((c + OFFSET) % total);
  if (SHUFFLE >= 1) for (var i = total - 1; i > 0; i--) { var k = Math.floor(rand() * (i + 1)); var t = order[i]; order[i] = order[k]; order[k] = t; }
  var chosen = [], blocked = {};
  for (var q = 0; q < total; q++) {
    var x = order[q];
    if (blocked[x]) continue;
    for (var s = 0; s < chosen.length; s++) blocked[third(x, chosen[s], n)] = 1;
    chosen.push(x); blocked[x] = 1;
  }
  return chosen;
}

function construct(input) {
  var best = [];
  for (var t = 0; t < Math.max(1, TRIES); t++) { var r = greedy(input.n); if (r.length > best.length) best = r; }
  return best.map(function (c) { return pointOf(c, input.n); });
}`;

function cube(n: number, digits: number[]): number[][] {
  let out: number[][] = [[]];
  for (let i = 0; i < n; i++) out = out.flatMap((p) => digits.map((d) => [...p, d]));
  return out;
}

export function capsetProblem(n: number): ProblemDef {
  const max = CAPSET_MAX[n] ?? null;
  return {
    id: `capset-${n}`,
    family: "capset",
    title_en: `Largest cap set in F_3^${n}`,
    title_ar: `أكبر مجموعة غطاء (cap set) في F_3^${n}`,
    statement_en: `Choose as many points of {0,1,2}^${n} as possible so that no three distinct chosen points a, b, c satisfy a+b+c ≡ 0 (mod 3) in every coordinate (no three on a line; the SET card game with ${n} attributes).`,
    statement_ar: `اختر أكبر عدد ممكن من نقاط {0,1,2}^${n} بحيث لا توجد ثلاث نقاط مختلفة a وb وc مجموعها ≡ 0 (بترديد 3) في كل إحداثي، أي لا توجد ثلاث نقاط على خط واحد (مثل لعبة SET بعدد ${n} صفات).`,
    direction: "max",
    params: { n },
    instance: { n },
    verifier: CAPSET_VERIFIER,
    seed_program: CAPSET_SEED,
    best_known: {
      score: max,
      status: max === null ? "unverified" : "proven_optimal",
      source: "OEIS A090245 (maximum cap sizes 1, 2, 4, 9, 20, 45, 112 for n = 0..6), https://oeis.org/A090245 ; n=5 by Edel, Ferret, Landjev & Storme (JCTA 2002), n=6 by A. Potechin, 'Maximal caps in AG(6,3)', Des. Codes Cryptogr. 46 (2008).",
    },
    examples: {
      good: [cube(n, [0, 1]), cube(n, [1, 2]), cube(n, [0, 2]).slice(0, 3)],
      bad: [cube(n, [0, 1, 2]).slice(0, 3), [cube(n, [0])[0], cube(n, [0])[0]], [[3, ...Array(n - 1).fill(0)]], [Array(n + 1).fill(0)]],
    },
    describe: (sol) => {
      const pts = sol as number[][];
      return pts.length ? Math.min(0.999, pts.filter((p) => p.includes(2)).length / pts.length) : 0;
    },
    limits: { constructFuel: 600, verifyFuel: 300 },
  };
}
