/** Built-in Discovery Lab problem registry (P4.5 starter set). */
import type { ProblemDef } from "../types";
import { capsetProblem } from "./capset";
import { facilityProblem } from "./facility";
import { golombProblem } from "./golomb";
import { squareProblem, tammesProblem } from "./packing";
import { ramseyProblem } from "./ramsey";
import { sidonProblem } from "./sidon";

export { golombProblem, GOLOMB_VERIFIER, GOLOMB_SEED, GOLOMB_OPTIMAL, GOLOMB_OPTIMAL_RULERS, greedyRuler } from "./golomb";
export { sidonProblem, SIDON_VERIFIER, SIDON_SEED, mianChowla, sidonMax } from "./sidon";
export { capsetProblem, CAPSET_VERIFIER, CAPSET_SEED, CAPSET_MAX } from "./capset";
export { squareProblem, tammesProblem, SQUARE_VERIFIER, TAMMES_VERIFIER, SQUARE_BEST, TAMMES_BEST, icosahedron, fibonacciSphere } from "./packing";
export { ramseyProblem, RAMSEY_VERIFIER, RAMSEY_BEST, paley, circulant, bipartite } from "./ramsey";
export { facilityProblem, generateCity, cityCost, FACILITY_VERIFIER, FACILITY_OPTIMA } from "./facility";

let cache: ProblemDef[] | null = null;

export function builtinProblems(): ProblemDef[] {
  if (!cache) {
    cache = [
      ...[10, 11, 12, 13, 14].map(golombProblem),
      sidonProblem(100),
      sidonProblem(200),
      ...[4, 5, 6].map(capsetProblem),
      ...[10, 13, 14, 16].map(squareProblem),
      ...[12, 13, 14, 20, 24].map(tammesProblem),
      ramseyProblem(3, 5),
      ramseyProblem(4, 4),
      ramseyProblem(5, 5),
      facilityProblem(2026, 5),
    ].map((p) => ({ ...p, source: "builtin" }));
  }
  return cache;
}

export function getBuiltinProblem(id: string): ProblemDef | undefined {
  return builtinProblems().find((p) => p.id === id);
}
