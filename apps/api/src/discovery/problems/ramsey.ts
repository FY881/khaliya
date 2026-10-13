/**
 * Ramsey lower-bound colourings: a red/blue colouring of K_k with no red K_s and no blue K_t proves
 * R(s,t) > k. Score = k (maximise). Values from Radziszowski's dynamic survey DS1 via
 * https://en.wikipedia.org/wiki/Ramsey%27s_theorem (fetched 2026-10-12): R(3,5)=14, R(4,4)=18, 43 ≤ R(5,5) ≤ 46.
 */
import type { BestKnown, ProblemDef } from "../types";

export const RAMSEY_BEST: Record<string, BestKnown> = {
  "3-5": { score: 13, status: "proven_optimal", source: "R(3,5) = 14 (Greenwood & Gleason 1955), so 13 vertices is the maximum. Radziszowski, 'Small Ramsey Numbers', Electron. J. Combin. DS1; https://en.wikipedia.org/wiki/Ramsey%27s_theorem" },
  "4-4": { score: 17, status: "proven_optimal", source: "R(4,4) = 18 (Greenwood & Gleason 1955); the Paley graph of order 17 is the unique (4,4,17) graph. https://en.wikipedia.org/wiki/Ramsey%27s_theorem" },
  "5-5": { score: 42, status: "best_known", source: "43 ≤ R(5,5) ≤ 46: lower bound by G. Exoo, 'A lower bound for R(5,5)', J. Graph Theory 13 (1989) — a 42-vertex colouring; upper bound by Angeltveit & McKay (2024), arXiv:2409.15709. McKay–Radziszowski conjecture R(5,5)=43. https://en.wikipedia.org/wiki/Ramsey%27s_theorem" },
};

export const RAMSEY_VERIFIER = `function verify(x) {
  try {
    var inst = x && x.instance; var rows = x && x.solution;
    var s = inst && inst.s, t = inst && inst.t, maxK = (inst && inst.maxK) || 64;
    if (typeof s !== "number" || typeof t !== "number" || s < 2 || t < 2 || s > 8 || t > 8) return { valid: false, detail: "bad instance" };
    if (!Array.isArray(rows) || rows.length < 1) return { valid: false, detail: "solution must be an array of k strings of '0'/'1' (row i, column j = colour of edge ij; '1' = red)" };
    var k = rows.length;
    if (k > maxK) return { valid: false, detail: "at most " + maxK + " vertices" };
    var red = [];
    for (var i = 0; i < k; i++) {
      var r = rows[i];
      if (typeof r !== "string" || r.length !== k) return { valid: false, detail: "row " + i + " must be a string of length " + k };
      red.push([]);
      for (var j = 0; j < k; j++) {
        var ch = r.charAt(j);
        if (ch !== "0" && ch !== "1") return { valid: false, detail: "row " + i + " has a character other than 0/1" };
        red[i].push(ch === "1");
      }
      if (red[i][i]) return { valid: false, detail: "diagonal must be 0" };
    }
    for (var a = 0; a < k; a++) for (var b = a + 1; b < k; b++) if (red[a][b] !== red[b][a]) return { valid: false, detail: "matrix is not symmetric at " + a + "," + b };
    function clique(colour, size) {
      function rec(cands, depth) {
        if (depth === size) return true;
        if (cands.length < size - depth) return false;
        for (var p = 0; p < cands.length; p++) {
          var v = cands[p], next = [];
          for (var q = p + 1; q < cands.length; q++) if (red[v][cands[q]] === colour) next.push(cands[q]);
          if (rec(next, depth + 1)) return true;
        }
        return false;
      }
      var all = []; for (var z = 0; z < k; z++) all.push(z);
      return rec(all, 0);
    }
    if (clique(true, s)) return { valid: false, detail: "contains a red K" + s };
    if (clique(false, t)) return { valid: false, detail: "contains a blue K" + t };
    return { valid: true, score: k, detail: "valid (" + s + "," + t + ")-colouring of K" + k };
  } catch (e) { return { valid: false, detail: "malformed solution" }; }
}`;

export const RAMSEY_SEED = `// Naive Ramsey colouring: complete bipartite red graph on K vertices (no red triangle, blue = two cliques).
// Valid for s >= 3 while ceil(K/2) < t. Knobs are tuned by evolution; smarter programs (circulant / Paley
// colourings) are left for the LLM mutations to discover.
var K = 4;
var MODE = 0;      // >= 1: circulant colouring, red iff the cyclic distance is in RED_SET
var RED_SET = [1]; // used when MODE >= 1

function construct(input) {
  var k = Math.max(1, Math.floor(K)), rows = [];
  for (var i = 0; i < k; i++) {
    var r = "";
    for (var j = 0; j < k; j++) {
      if (i === j) { r += "0"; continue; }
      var red;
      if (MODE >= 1) { var d = Math.abs(i - j); d = Math.min(d, k - d); red = RED_SET.indexOf(d) >= 0; }
      else red = (i % 2) !== (j % 2);
      r += red ? "1" : "0";
    }
    rows.push(r);
  }
  return rows;
}`;

/** Circulant colouring on k vertices: red iff the cyclic distance lies in `dists`. */
export function circulant(k: number, dists: number[]): string[] {
  return Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => {
      if (i === j) return "0";
      const d = Math.min(Math.abs(i - j), k - Math.abs(i - j));
      return dists.includes(d) ? "1" : "0";
    }).join(""),
  );
}

/** Paley colouring for a prime p ≡ 1 (mod 4): red iff i−j is a non-zero quadratic residue. */
export function paley(p: number): string[] {
  const qr = new Set<number>();
  for (let x = 1; x < p; x++) qr.add((x * x) % p);
  return Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => (i !== j && qr.has((((i - j) % p) + p) % p) ? "1" : "0")).join(""));
}

function uniform(k: number, c: "0" | "1"): string[] {
  return Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? "0" : c)).join(""));
}

export function bipartite(k: number): string[] {
  return Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i !== j && i % 2 !== j % 2 ? "1" : "0")).join(""));
}

export function ramseyProblem(s: number, t: number): ProblemDef {
  const key = `${s}-${t}`;
  const best: BestKnown = RAMSEY_BEST[key] ?? { score: null, status: "unverified", source: "no value recorded" };
  const goods: Record<string, string[][]> = {
    "3-5": [circulant(13, [1, 5]), bipartite(8)],
    "4-4": [paley(17), bipartite(6)],
    "5-5": [paley(37), bipartite(8)],
  };
  return {
    id: `ramsey-${key}`,
    family: "ramsey",
    title_en: `Ramsey colouring R(${s},${t}): largest K_k with no red K${s} and no blue K${t}`,
    title_ar: `تلوين رامزي R(${s},${t}): أكبر رسم كامل بلا مثلث أحمر K${s} ولا K${t} أزرق`,
    statement_en: `Colour every edge of the complete graph on k vertices red or blue so that there is no red complete subgraph on ${s} vertices and no blue complete subgraph on ${t} vertices. Maximise k (each valid colouring proves R(${s},${t}) > k).`,
    statement_ar: `لوّن كل ضلع في الرسم الكامل ذي k رأسًا بالأحمر أو الأزرق بحيث لا يوجد رسم كامل أحمر على ${s} رؤوس ولا رسم كامل أزرق على ${t} رؤوس. اجعل k أكبر ما يمكن (كل تلوين صحيح يثبت أن R(${s},${t}) > k).`,
    direction: "max",
    params: { s, t },
    instance: { s, t, maxK: 64 },
    verifier: RAMSEY_VERIFIER,
    seed_program: RAMSEY_SEED,
    best_known: best,
    examples: {
      good: goods[key] ?? [bipartite(2 * (t - 1))],
      bad: [
        uniform(Math.max(s, t) + 1, "1"), // all red
        uniform(Math.max(s, t) + 1, "0"), // all blue
        ["01", "00"], // not symmetric
        ["0x", "x0"],
      ],
    },
    describe: (sol) => {
      const rows = sol as string[];
      const k = rows.length;
      if (k < 2) return 0;
      let red = 0;
      for (const r of rows) for (const c of r) if (c === "1") red++;
      return Math.min(0.999, red / (k * (k - 1)));
    },
    limits: { constructFuel: 300, verifyFuel: 800 },
  };
}
