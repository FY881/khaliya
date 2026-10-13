/**
 * Humanitarian optimisation: place k clinics among candidate public sites of a synthetic city so the
 * household-weighted average travel distance to the nearest clinic is minimal.
 *
 * The city is synthetic and public: generated deterministically from a seed (neighbourhood centres, then
 * households scattered around them with a household size 1..6, then candidate sites such as schools and
 * municipal buildings). Travel distance is grid (L1 / Manhattan) distance in a 100×100 km box.
 * The best-known value is the EXACT optimum found by exhaustive search over all C(sites, k) choices
 * (computed offline for this repo — not a literature value).
 */
import { mulberry32 } from "../../evolution/bandit";
import type { ProblemDef } from "../types";

export interface City {
  seed: number;
  households: number[][]; // [x, y, people]
  sites: number[][]; // [x, y]
  k: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function generateCity(seed: number, nHouseholds = 240, nSites = 36, k = 5, nCentres = 5): City {
  const rng = mulberry32(seed);
  const centres = Array.from({ length: nCentres }, () => [10 + rng() * 80, 10 + rng() * 80, 4 + rng() * 10]);
  const households: number[][] = [];
  for (let i = 0; i < nHouseholds; i++) {
    const c = centres[Math.floor(rng() * nCentres)];
    // approx. normal scatter: sum of three uniforms
    const gx = (rng() + rng() + rng() - 1.5) * c[2];
    const gy = (rng() + rng() + rng() - 1.5) * c[2];
    households.push([r1(Math.min(100, Math.max(0, c[0] + gx))), r1(Math.min(100, Math.max(0, c[1] + gy))), 1 + Math.floor(rng() * 6)]);
  }
  const sites = Array.from({ length: nSites }, () => [r1(rng() * 100), r1(rng() * 100)]);
  return { seed, households, sites, k };
}

/** Host-side scorer (same formula as the guest verifier). */
export function cityCost(city: City, chosen: number[]): number {
  let tot = 0;
  let w = 0;
  for (const h of city.households) {
    let best = Infinity;
    for (const s of chosen) {
      const d = Math.abs(h[0] - city.sites[s][0]) + Math.abs(h[1] - city.sites[s][1]);
      if (d < best) best = d;
    }
    tot += best * h[2];
    w += h[2];
  }
  return tot / w;
}

/**
 * Exact optima computed offline (script work/discovery-bench/opt.ts in the project workspace, exhaustive over all C(36,5) = 376,992
 * subsets) for the instances registered below. Re-checked by the tests via the verifier on the stored
 * optimal choice.
 */
export const FACILITY_OPTIMA: Record<number, { score: number; choice: number[] }> = {
  // key = seed * 100 + k
  202605: { score: 11.033838973162196, choice: [1, 5, 7, 33, 35] },
};

export const FACILITY_VERIFIER = `function verify(x) {
  try {
    var c = x && x.instance; var sol = x && x.solution;
    if (!c || !Array.isArray(c.households) || !Array.isArray(c.sites) || typeof c.k !== "number") return { valid: false, detail: "bad instance" };
    var k = c.k, S = c.sites.length;
    if (!Array.isArray(sol) || sol.length !== k) return { valid: false, detail: "solution must be an array of " + k + " site indices" };
    var used = {};
    for (var i = 0; i < k; i++) {
      var v = sol[i];
      if (typeof v !== "number" || v !== Math.floor(v) || v < 0 || v >= S) return { valid: false, detail: "index " + i + " is not a site index in [0, " + (S - 1) + "]" };
      if (used[v]) return { valid: false, detail: "site " + v + " chosen twice" };
      used[v] = 1;
    }
    var tot = 0, w = 0;
    for (var h = 0; h < c.households.length; h++) {
      var hh = c.households[h], best = Infinity;
      for (var j = 0; j < k; j++) {
        var s = c.sites[sol[j]], d = Math.abs(hh[0] - s[0]) + Math.abs(hh[1] - s[1]);
        if (d < best) best = d;
      }
      tot += best * hh[2]; w += hh[2];
    }
    var avg = tot / w;
    return { valid: true, score: avg, detail: "average travel " + avg.toFixed(6) + " km" };
  } catch (e) { return { valid: false, detail: "malformed solution" }; }
}`;

export const FACILITY_SEED = `// Naive clinic placement: take k consecutive candidate sites starting at OFFSET, then optional swap-based
// local search (SWEEPS passes; each pass tries replacing every chosen site by every unused site).
var OFFSET = 0;
var SWEEPS = 0;

function cost(input, chosen) {
  var tot = 0, w = 0, H = input.households, S = input.sites;
  for (var h = 0; h < H.length; h++) {
    var best = Infinity;
    for (var j = 0; j < chosen.length; j++) {
      var s = S[chosen[j]], d = Math.abs(H[h][0] - s[0]) + Math.abs(H[h][1] - s[1]);
      if (d < best) best = d;
    }
    tot += best * H[h][2]; w += H[h][2];
  }
  return tot / w;
}

function construct(input) {
  var k = input.k, S = input.sites.length, chosen = [];
  for (var i = 0; i < k; i++) chosen.push((Math.floor(OFFSET) + i) % S);
  var cur = cost(input, chosen);
  for (var sw = 0; sw < SWEEPS; sw++) {
    var improved = false;
    for (var a = 0; a < k; a++) for (var c = 0; c < S; c++) {
      if (chosen.indexOf(c) >= 0) continue;
      var old = chosen[a]; chosen[a] = c;
      var v = cost(input, chosen);
      if (v < cur - 1e-12) { cur = v; improved = true; } else chosen[a] = old;
    }
    if (!improved) break;
  }
  return chosen;
}`;

export function facilityProblem(seed = 2026, k = 5): ProblemDef {
  const city = generateCity(seed, 240, 36, k);
  const opt = FACILITY_OPTIMA[seed * 100 + k];
  return {
    id: `clinics-${seed}-k${k}`,
    family: "facility",
    title_en: `Clinic placement: ${k} clinics in synthetic city #${seed}`,
    title_ar: `توزيع العيادات: ${k} عيادات في المدينة الافتراضية رقم ${seed}`,
    statement_en: `A synthetic city has ${city.households.length} households (with household sizes) and ${city.sites.length} candidate public sites. Open exactly ${k} clinics at candidate sites so that the average travel distance (grid/Manhattan km, weighted by people) from each household to its nearest clinic is as small as possible.`,
    statement_ar: `مدينة افتراضية فيها ${city.households.length} أسرة (مع عدد أفراد كل أسرة) و${city.sites.length} موقعًا عامًا مرشحًا. افتح ${k} عيادات بالضبط في مواقع مرشحة بحيث يكون متوسط مسافة السفر (كم بشبكة الشوارع، مرجّحة بعدد الأفراد) من كل أسرة إلى أقرب عيادة أصغر ما يمكن.`,
    direction: "min",
    params: { seed, households: 240, sites: 36, k },
    instance: { households: city.households, sites: city.sites, k },
    verifier: FACILITY_VERIFIER,
    seed_program: FACILITY_SEED,
    best_known: opt
      ? { score: opt.score, status: "computed", source: `Exact optimum by exhaustive search over all C(36,${k}) site choices, computed offline for this repo on 2026-10-12 (synthetic instance; not a literature value). Optimal sites: [${opt.choice.join(", ")}].` }
      : { score: null, status: "unverified", source: "optimum not computed for this instance" },
    tolerance: 1e-9,
    examples: {
      good: [Array.from({ length: k }, (_, i) => i), Array.from({ length: k }, (_, i) => city.sites.length - 1 - i)],
      bad: [Array.from({ length: k }, () => 0), Array.from({ length: k - 1 }, (_, i) => i), [...Array.from({ length: k - 1 }, (_, i) => i), city.sites.length], [...Array.from({ length: k - 1 }, (_, i) => i), 1.5]],
    },
    describe: (sol) => {
      const s = sol as number[];
      return Math.min(0.999, s.reduce((a, i) => a + city.sites[i][0], 0) / s.length / 100);
    },
    limits: { constructFuel: 600, verifyFuel: 100 },
  };
}
