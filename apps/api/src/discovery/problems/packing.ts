/**
 * Geometric packing problems.
 *  - points-square-N: N points in the unit square, maximise the minimum pairwise distance (equivalent to
 *    packing N equal circles in a square). Values from Packomania (E. Specht), proven optimal for N ≤ 30.
 *  - tammes-N: N points on the unit sphere, maximise the minimum angle (Tammes problem). Values from
 *    L. Hars, "Numerical solutions of the Tammes problem for up to 60 points" (2020); proven for N ≤ 14
 *    and N = 24 (Musin & Tarasov 2015 for N=14; Robinson 1961 for N=24), N=20 is numerical (conjectured).
 */
import type { BestKnown, ProblemDef } from "../types";

export const SQUARE_BEST: Record<number, number> = {
  10: 0.421279543983903,
  13: 0.366096007696,
  14: 0.348915260374,
  16: 1 / 3,
};

export const SQUARE_VERIFIER = `function verify(x) {
  try {
    var N = x && x.instance && x.instance.N; var p = x && x.solution;
    if (typeof N !== "number" || N < 2 || N > 400) return { valid: false, detail: "bad instance" };
    if (!Array.isArray(p) || p.length !== N) return { valid: false, detail: "solution must be an array of " + N + " points [x, y]" };
    for (var i = 0; i < N; i++) {
      var q = p[i];
      if (!Array.isArray(q) || q.length !== 2) return { valid: false, detail: "point " + i + " must be [x, y]" };
      for (var k = 0; k < 2; k++) {
        var v = q[k];
        if (typeof v !== "number" || !(v >= 0 && v <= 1)) return { valid: false, detail: "point " + i + " is outside the unit square" };
      }
    }
    var best = Infinity;
    for (var a = 0; a < N; a++) for (var b = a + 1; b < N; b++) {
      var dx = p[a][0] - p[b][0], dy = p[a][1] - p[b][1], d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    var m = Math.sqrt(best);
    if (!(m > 0)) return { valid: false, detail: "two points coincide" };
    return { valid: true, score: m, detail: "min distance " + m.toFixed(12) };
  } catch (e) { return { valid: false, detail: "malformed solution" }; }
}`;

export const SQUARE_SEED = `// Naive point spreader: a COLS-column grid filled row by row, then optional random repulsion steps.
var COLS = 3;
var STAGGER = 0;    // shift odd rows by STAGGER * cell width
var ITERS = 0;      // repulsion iterations
var STEP = 0.05;    // repulsion step size

function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function minDist(p) {
  var m = Infinity;
  for (var a = 0; a < p.length; a++) for (var b = a + 1; b < p.length; b++) {
    var dx = p[a][0] - p[b][0], dy = p[a][1] - p[b][1], d = Math.sqrt(dx * dx + dy * dy);
    if (d < m) m = d;
  }
  return m;
}

function construct(input) {
  var N = input.N, cols = Math.max(2, Math.floor(COLS)), rows = Math.ceil(N / cols), pts = [];
  for (var i = 0; i < N; i++) {
    var r = Math.floor(i / cols), c = i % cols;
    var x = c / (cols - 1) + (r % 2 ? STAGGER / (cols - 1) : 0);
    pts.push([clamp(x), rows > 1 ? r / (rows - 1) : 0.5]);
  }
  var cur = minDist(pts);
  for (var it = 0; it < ITERS; it++) {
    var k = Math.floor(rand() * N), old = pts[k];
    pts[k] = [clamp(old[0] + (rand() - 0.5) * STEP), clamp(old[1] + (rand() - 0.5) * STEP)];
    var m = minDist(pts);
    if (m >= cur) cur = m; else pts[k] = old;
  }
  return pts;
}`;

export const TAMMES_BEST: Record<number, BestKnown> = {
  12: { score: (Math.atan(2) * 180) / Math.PI, status: "proven_optimal", source: "Icosahedron, arctan(2) = 63.4349488°; proven (Fejes Tóth 1943). Hars 2020 table §10.12, https://www.hars.us/Papers/Numerical_Tammes.pdf" },
  13: { score: (Math.acos(0.5426364868) * 180) / Math.PI, status: "proven_optimal", source: "57.1367031° (cos α = 0.5426364868); proven by Musin & Tarasov, 'The strong thirteen spheres problem', DCG 48 (2012). Value from Hars 2020 §10.13, https://www.hars.us/Papers/Numerical_Tammes.pdf" },
  14: { score: (Math.acos(0.5639503003) * 180) / Math.PI, status: "proven_optimal", source: "55.6705700° (cos α = 0.5639503003); proven by Musin & Tarasov, 'The Tammes problem for N = 14', Experimental Mathematics 24(4) 2015, doi:10.1080/10586458.2015.1022842. Value from Hars 2020 §10.14." },
  20: { score: (Math.acos(0.6764771381) * 180) / Math.PI, status: "conjectured", source: "47.4310362° (cos α = 0.6764771381); numerical optimum, not proven. L. Hars, 'Numerical solutions of the Tammes problem for up to 60 points' (2020) §10.20, https://www.hars.us/Papers/Numerical_Tammes.pdf" },
  24: { score: (Math.acos(0.7230784683) * 180) / Math.PI, status: "proven_optimal", source: "43.6907671° (cos α = 0.7230784683); proven by R. M. Robinson (1961). Value from Hars 2020 §10.24, https://www.hars.us/Papers/Numerical_Tammes.pdf" },
};

export const TAMMES_VERIFIER = `function verify(x) {
  try {
    var N = x && x.instance && x.instance.N; var p = x && x.solution;
    if (typeof N !== "number" || N < 2 || N > 400) return { valid: false, detail: "bad instance" };
    if (!Array.isArray(p) || p.length !== N) return { valid: false, detail: "solution must be an array of " + N + " vectors [x, y, z]" };
    var u = [];
    for (var i = 0; i < N; i++) {
      var q = p[i];
      if (!Array.isArray(q) || q.length !== 3) return { valid: false, detail: "point " + i + " must be [x, y, z]" };
      for (var k = 0; k < 3; k++) if (typeof q[k] !== "number" || !isFinite(q[k]) || Math.abs(q[k]) > 1e6) return { valid: false, detail: "point " + i + " has a non-finite coordinate" };
      var len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
      if (!(len > 1e-9)) return { valid: false, detail: "point " + i + " is the zero vector" };
      u.push([q[0] / len, q[1] / len, q[2] / len]);
    }
    var maxDot = -1;
    for (var a = 0; a < N; a++) for (var b = a + 1; b < N; b++) {
      var d = u[a][0] * u[b][0] + u[a][1] * u[b][1] + u[a][2] * u[b][2];
      if (d > maxDot) maxDot = d;
    }
    if (maxDot > 1) maxDot = 1;
    var ang = Math.acos(maxDot) * 180 / Math.PI;
    if (!(ang > 0)) return { valid: false, detail: "two points coincide" };
    return { valid: true, score: ang, detail: "min angle " + ang.toFixed(9) + " deg" };
  } catch (e) { return { valid: false, detail: "malformed solution" }; }
}`;

export const TAMMES_SEED = `// Naive sphere spreader: a Fibonacci spiral, then optional random repulsion steps.
var OFFSET = 0.5;
var ITERS = 0;
var STEP = 0.1;

function norm(v) { var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function maxDot(p) {
  var m = -1;
  for (var a = 0; a < p.length; a++) for (var b = a + 1; b < p.length; b++) {
    var d = p[a][0] * p[b][0] + p[a][1] * p[b][1] + p[a][2] * p[b][2];
    if (d > m) m = d;
  }
  return m;
}

function construct(input) {
  var N = input.N, pts = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (var i = 0; i < N; i++) {
    var z = 1 - 2 * (i + OFFSET) / N, r = Math.sqrt(Math.max(0, 1 - z * z));
    pts.push([r * Math.cos(ga * i), r * Math.sin(ga * i), z]);
  }
  var cur = maxDot(pts);
  for (var it = 0; it < ITERS; it++) {
    var k = Math.floor(rand() * N), old = pts[k];
    pts[k] = norm([old[0] + (rand() - 0.5) * STEP, old[1] + (rand() - 0.5) * STEP, old[2] + (rand() - 0.5) * STEP]);
    var m = maxDot(pts);
    if (m <= cur) cur = m; else pts[k] = old;
  }
  return pts;
}`;

function gridPoints(N: number, cols: number): number[][] {
  const rows = Math.ceil(N / cols);
  return Array.from({ length: N }, (_, i) => [(i % cols) / (cols - 1), rows > 1 ? Math.floor(i / cols) / (rows - 1) : 0.5]);
}

export function fibonacciSphere(N: number, offset = 0.5): number[][] {
  const ga = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: N }, (_, i) => {
    const z = 1 - (2 * (i + offset)) / N;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(ga * i), r * Math.sin(ga * i), z];
  });
}

export function icosahedron(): number[][] {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [];
  for (const a of [-1, 1]) for (const b of [-t, t]) v.push([0, a, b], [a, b, 0], [b, 0, a]);
  return v;
}

export function squareProblem(N: number): ProblemDef {
  const best = SQUARE_BEST[N] ?? null;
  return {
    id: `points-square-${N}`,
    family: "points-square",
    title_en: `Spread ${N} points in a unit square`,
    title_ar: `توزيع ${N} نقطة داخل مربع الوحدة`,
    statement_en: `Place ${N} points in the unit square [0,1]×[0,1] so that the smallest distance between any two points is as large as possible (equivalent to packing ${N} equal circles in a square).`,
    statement_ar: `ضع ${N} نقطة داخل مربع الوحدة [0,1]×[0,1] بحيث تكون أصغر مسافة بين أي نقطتين أكبر ما يمكن (مكافئ لتعبئة ${N} دائرة متساوية داخل مربع).`,
    direction: "max",
    params: { N },
    instance: { N },
    verifier: SQUARE_VERIFIER,
    seed_program: SQUARE_SEED,
    best_known: {
      score: best,
      status: best === null ? "unverified" : "proven_optimal",
      source: `Packomania, 'The best known packings of equal circles in a square' (E. Specht), https://www.packomania.com/csq/csq.html — 'distance' column (N=10: 0.421279543984, N=13: 0.366096007696, N=14: 0.348915260374; N=16: 1/3, the 4×4 grid). Optima for N ≤ 30 are proven (Markót, Csendes and others).`,
    },
    tolerance: 1e-9,
    examples: {
      good: [gridPoints(N, Math.ceil(Math.sqrt(N))), gridPoints(N, Math.ceil(Math.sqrt(N)) + 1)],
      bad: [gridPoints(N - 1, 3), [...gridPoints(N - 1, 4), [1.5, 0.5]], [...gridPoints(N - 1, 4), [0, 0]], [...gridPoints(N - 1, 4), [0.5, null]]],
    },
    describe: (sol) => {
      const p = sol as number[][];
      const onEdge = p.filter((q) => q[0] < 1e-6 || q[1] < 1e-6 || q[0] > 1 - 1e-6 || q[1] > 1 - 1e-6).length;
      return Math.min(0.999, onEdge / p.length);
    },
    limits: { constructFuel: 400, verifyFuel: 100 },
  };
}

export function tammesProblem(N: number): ProblemDef {
  const best: BestKnown = TAMMES_BEST[N] ?? { score: null, status: "unverified", source: "no value recorded" };
  return {
    id: `tammes-${N}`,
    family: "tammes",
    title_en: `Tammes problem: ${N} points on a sphere`,
    title_ar: `مسألة تامس: ${N} نقطة على كرة`,
    statement_en: `Place ${N} points on the unit sphere so that the smallest angle between any two of them (seen from the centre) is as large as possible. Score in degrees.`,
    statement_ar: `ضع ${N} نقطة على كرة الوحدة بحيث تكون أصغر زاوية بين أي نقطتين (من المركز) أكبر ما يمكن. النتيجة بالدرجات.`,
    direction: "max",
    params: { N },
    instance: { N },
    verifier: TAMMES_VERIFIER,
    seed_program: TAMMES_SEED,
    best_known: best,
    // Literature values carry ~10 significant digits; a "beat" smaller than this is numerical noise.
    tolerance: 1e-6,
    examples: {
      good: N === 12 ? [icosahedron(), fibonacciSphere(12)] : [fibonacciSphere(N), fibonacciSphere(N, 0.3)],
      bad: [fibonacciSphere(N - 1), [...fibonacciSphere(N - 1), [0, 0, 0]], [...fibonacciSphere(N - 1), fibonacciSphere(N - 1)[0]], [...fibonacciSphere(N - 1), [1, "a", 0]]],
    },
    describe: (sol) => {
      const p = sol as number[][];
      return Math.min(0.999, p.filter((q) => q[2] > 0).length / p.length);
    },
    limits: { constructFuel: 400, verifyFuel: 100 },
  };
}
