/**
 * Discovery Lab types (ARCHITECTURE §17, P4.5).
 *
 * A problem is a machine-checkable question: a deterministic verifier (guest JS, runs in the Forge sandbox
 * through runVerifier) scores any candidate solution. Programs (guest JS declaring `construct(input)`) are
 * evolved; each program's output is verified; improvements become candidate records with a certificate.
 */

export type Direction = "max" | "min";

/** How solid the best-known value is. Only literature values may be "proven_optimal" / "best_known". */
export type BestKnownStatus =
  | "proven_optimal" // the optimum is known and proven (beating it means the verifier or the run is wrong)
  | "best_known" // best published construction; the true optimum is open
  | "derived" // follows from a cited result by a short argument stated in `source`
  | "conjectured" // numerical optimum from the literature, not proven
  | "computed" // computed by this repo (e.g. exhaustive search on a synthetic instance), not literature
  | "unverified"; // we could not confirm the value from a source

export interface BestKnown {
  score: number | null;
  status: BestKnownStatus;
  /** Citation text: paper / OEIS / website, with URL where possible. */
  source: string;
}

export interface ProblemLimits {
  /** Sandbox fuel for one construct(input) run (interrupt ticks ≈ 10k guest ops each). */
  constructFuel?: number;
  /** Sandbox fuel for one verifier run. */
  verifyFuel?: number;
}

export interface ProblemDef {
  /** Stable slug, e.g. "golomb-10". */
  id: string;
  family: string;
  title_en: string;
  title_ar: string;
  statement_en: string;
  statement_ar: string;
  direction: Direction;
  /** Instance parameters as they would be stated by a human (e.g. {n: 10}). */
  params: Record<string, unknown>;
  /** Full instance handed to construct(input) and to the verifier (may be generated from params). */
  instance: Record<string, unknown>;
  /** Guest JS declaring `verify({solution, instance})` → {valid, score, detail}. */
  verifier: string;
  /** Guest JS declaring `construct(input)` → solution. A naive, valid starting point. */
  seed_program: string;
  best_known: BestKnown;
  /** Known-good and known-bad solutions (the same contract owner/agent submissions must meet). */
  examples: { good: unknown[]; bad: unknown[] };
  /** Absolute tolerance used when comparing float scores (records, beats-known). Default 1e-9. */
  tolerance?: number;
  limits?: ProblemLimits;
  /** Host-side behaviour descriptor in [0,1) for MAP-Elites (never throws: wrapped by the engine). */
  describe?: (solution: unknown, instance: Record<string, unknown>) => number;
  /** "builtin" or the submitter ("owner", "agent:<id>"). */
  source?: string;
}

export type RecordStatus = "candidate" | "verified" | "beats_known_needs_review" | "rejected";
export type VsKnown = "below" | "matches" | "beats" | "unknown";
export type OperatorId = "llm" | "tweak" | "crossover";
