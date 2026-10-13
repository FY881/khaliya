/** Tool Forge types (ARCHITECTURE §7). */
import type { Checker, JsonSchema } from "../eval/types";
import type { SandboxLimits, SandboxRequest, SandboxResult } from "./sandbox";

export type { JsonSchema } from "../eval/types";

/** One author test. Exactly one of `expect` (canonical-JSON equality) or `checker` must be given. */
export interface ForgeTest {
  input: unknown;
  expect?: unknown;
  /**
   * A deterministic eval checker (exact|regex|numeric|contains|json_schema; rubric is not allowed),
   * applied to the result: strings as-is, everything else as its JSON text.
   */
  checker?: Exclude<Checker, { type: "rubric" }>;
  name?: string;
}

/** What a Toolsmith submits. */
export interface ForgeToolSpec {
  /** forge.<segment>[.<segment>…], lowercase, e.g. forge.text.slugify */
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** Optional: every output (author tests + hidden tests) must match it. */
  output_schema?: JsonSchema;
  /** Guest JavaScript (QuickJS). Must declare a global function named `entry` (default "run"). */
  code: string;
  entry?: string;
  tests: ForgeTest[];
  /** agent:<id> | owner | system:<x> */
  author: string;
  /** Genome lineage of the author. Hidden tests and the critic must come from a DIFFERENT lineage. */
  lineage: string;
  /** Requested sandbox limits (clamped to HARD_LIMITS; can only lower them). */
  limits?: SandboxLimits;
}

export type ForgeStatus = "pending" | "admitted" | "rejected" | "deprecated";

export type GateName = "structure" | "static" | "author_tests" | "adversarial" | "determinism" | "budget" | "critic";
export const GATE_ORDER: GateName[] = ["structure", "static", "author_tests", "adversarial", "determinism", "budget", "critic"];

export interface GateResult {
  gate: GateName;
  pass: boolean;
  skipped?: boolean;
  reason?: string;
  warnings?: string[];
  detail?: Record<string, unknown>;
}

export interface AdmissionReport {
  status: "admitted" | "rejected";
  hash: string;
  reason?: string;
  gates: GateResult[];
  warnings: string[];
  stats: { runs: number; maxFuel: number; maxMs: number; maxOutputBytes: number; hiddenTests: number; crashes: number };
  at: number;
}

/** Critic review hook (an LLM of a protected Critic/Evaluator lineage in production; a mock in tests). */
export interface CriticVerdict {
  approve: boolean;
  reason: string;
  risk?: "low" | "medium" | "high";
}
export interface Critic {
  lineage: string;
  review(input: { spec: ForgeToolSpec; warnings: string[]; gates: GateResult[] }): Promise<CriticVerdict>;
}

/** Hidden adversarial input generator from a different lineage (Evaluator / Critic). */
export interface Adversary {
  lineage: string;
  generate(spec: Omit<ForgeToolSpec, "tests" | "code"> & { code: string }): Promise<unknown[]>;
}

export interface AdmissionDeps {
  critic?: Critic;
  adversary?: Adversary;
  /** Number of schema-fuzz cases (default 12, max 40). */
  fuzzCases?: number;
  /** Names already taken by built-in catalog tools. */
  reservedNames?: string[];
  /** Plan fuel cap (free plan: a few ticks per run); the tool's own fuel limit is lowered to it, never raised. */
  fuelCap?: number | null;
  /** Sandbox runner override (tests / instrumentation). Defaults to runSandboxed. */
  runner?: (req: SandboxRequest) => Promise<SandboxResult>;
}
