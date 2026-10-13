/**
 * Sidon sets (B2 sets) in [1..N]: all pairwise sums a+b (a ≤ b) distinct; maximise the size.
 * A Sidon set of size k inside [1..N] exists iff an optimal Golomb ruler with k marks has length ≤ N−1
 * (translate the ruler by +1). With OEIS A003022 (G(12)=85, G(13)=106, G(17)=199, G(18)=216):
 * max size in [1..100] = 12, in [1..200] = 17.
 */
import type { ProblemDef } from "../types";
import { GOLOMB_OPTIMAL, GOLOMB_OPTIMAL_RULERS } from "./golomb";

export const SIDON_VERIFIER = `function verify(x) {
  try {
    var N = x && x.instance && x.instance.N; var s = x && x.solution;
    if (typeof N !== "number" || N < 1 || N > 100000) return { valid: false, detail: "bad instance" };
    if (!Array.isArray(s)) return { valid: false, detail: "solution must be an array of integers" };
    if (s.length > N) return { valid: false, detail: "more elements than [1..N] holds" };
    var a = [];
    for (var i = 0; i < s.length; i++) {
      var v = s[i];
      if (typeof v !== "number" || v !== Math.floor(v) || v < 1 || v > N) return { valid: false, detail: "element " + i + " is not an integer in [1, " + N + "]" };
      a.push(v);
    }
    a.sort(function (p, q) { return p - q; });
    var seen = {};
    for (var p = 0; p < a.length; p++) {
      if (p > 0 && a[p] === a[p - 1]) return { valid: false, detail: "duplicate element " + a[p] };
      for (var q = p; q < a.length; q++) {
        var sum = a[p] + a[q];
        if (seen[sum]) return { valid: false, detail: "repeated sum " + sum };
        seen[sum] = 1;
      }
    }
    return { valid: true, score: a.length, detail: "size " + a.length };
  } catch (e) { return { valid: false, detail: "malformed solution" }; }
}`;

export const SIDON_SEED = `// Naive Sidon-set constructor: scan candidates START, START+STEP, ... and keep each one that keeps all sums distinct.
var START = 1;
var STEP = 5;
var SKIP = 0.0; // probability of skipping a feasible candidate (randomised greedy)
var TRIES = 1;  // best of TRIES runs

function scan(N) {
  var set = [], sums = {};
  for (var x = START; x <= N; x += Math.max(1, STEP)) {
    var ok = !sums[x + x];
    for (var i = 0; ok && i < set.length; i++) if (sums[x + set[i]]) ok = false;
    if (ok && rand() >= SKIP) {
      for (var j = 0; j < set.length; j++) sums[x + set[j]] = 1;
      sums[x + x] = 1;
      set.push(x);
    }
  }
  return set;
}

function construct(input) {
  var best = [];
  for (var t = 0; t < Math.max(1, TRIES); t++) { var r = scan(input.N); if (r.length > best.length) best = r; }
  return best;
}`;

export function mianChowla(N: number): number[] {
  const set: number[] = [];
  const sums = new Set<number>();
  for (let x = 1; x <= N; x++) {
    if (sums.has(2 * x) || set.some((y) => sums.has(x + y))) continue;
    for (const y of set) sums.add(x + y);
    sums.add(2 * x);
    set.push(x);
  }
  return set;
}

/** Largest k with G(k) ≤ N − 1 (G = optimal Golomb length). */
export function sidonMax(N: number): number | null {
  let k = 1;
  while (GOLOMB_OPTIMAL[k + 1] !== undefined && GOLOMB_OPTIMAL[k + 1] <= N - 1) k++;
  return GOLOMB_OPTIMAL[k + 1] === undefined ? null : k;
}

export function sidonProblem(N: number): ProblemDef {
  const best = sidonMax(N);
  const ruler = best !== null ? GOLOMB_OPTIMAL_RULERS[best] : undefined;
  const good: unknown[] = [mianChowla(N)];
  if (ruler) good.push(ruler.map((m) => m + 1));
  else good.push(mianChowla(N).slice(0, -1));
  const mc = mianChowla(N);
  return {
    id: `sidon-${N}`,
    family: "sidon",
    title_en: `Largest Sidon set in [1..${N}]`,
    title_ar: `أكبر مجموعة سيدون داخل [1..${N}]`,
    statement_en: `Choose as many distinct integers from 1..${N} as possible so that all sums a+b (a ≤ b, repeats allowed) are different.`,
    statement_ar: `اختر أكبر عدد ممكن من الأعداد الصحيحة المختلفة من 1 إلى ${N} بحيث تكون كل المجاميع a+b (مع a ≤ b ويُسمح بالتكرار) مختلفة.`,
    direction: "max",
    params: { N },
    instance: { N },
    verifier: SIDON_VERIFIER,
    seed_program: SIDON_SEED,
    best_known: {
      score: best,
      status: best === null ? "unverified" : "derived",
      source:
        "Derived from OEIS A003022 (optimal Golomb ruler lengths, https://oeis.org/A003022): a Sidon set of size k in [1..N] exists iff the optimal k-mark Golomb ruler has length ≤ N−1 (Sidon sets and Golomb rulers are the same objects up to translation; see https://en.wikipedia.org/wiki/Sidon_sequence). Hence 12 for N=100 (G(12)=85, G(13)=106) and 17 for N=200 (G(17)=199, G(18)=216).",
    },
    examples: {
      good,
      bad: [[1, 2, 3, 4], [...mc, mc[mc.length - 1]], [0, 5, 9], [1, 2.5, 7], "1,2,4,8"],
    },
    describe: (sol, inst) => {
      const s = sol as number[];
      const N2 = Number(inst.N) / 2;
      return s.length ? Math.min(0.999, s.filter((v) => v <= N2).length / s.length) : 0;
    },
    limits: { constructFuel: 300, verifyFuel: 200 },
  };
}
