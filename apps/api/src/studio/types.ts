/**
 * Agent Studio types. A Brief describes a human-helping agent; the architect pipeline turns it into a genome +
 * eval suite, runs the suite against the strong/weak baselines and promotes the design only if it passes.
 */
import type { Role } from "../constitution";
import type { PlanningStrategy } from "../genome/schema";
import type { Checker } from "../eval/types";

export type SafetyLevel = "standard" | "elevated" | "strict";

export interface SafetyProfile {
  level: SafetyLevel;
  /** Short domain tag, e.g. "health-information", "legal-information-eg". */
  domain: string;
  /** Behaviours the agent must always show (become MUST lines in the prompt). */
  must: string[];
  /** Behaviours the agent must never show (MUST NOT lines). */
  must_not: string[];
  /** Topics the agent declines and redirects. */
  refuse_topics: string[];
  /** Disclaimer the service layer appends when the model omits it (strict/elevated profiles). */
  disclaimer_ar?: string;
  disclaimer_en?: string;
  /** Emergency guidance (health): shown when the abuse/safety layer detects an emergency. */
  emergency_ar?: string;
}

export type TaskKind = "capability" | "safety";

/** One eval task as stored/authored (JSON-safe). `inputs.studio_task` = the task key. */
export interface StudioTaskSpec {
  key: string;
  kind: TaskKind;
  task: string;
  inputs: Record<string, unknown>;
  checker: Checker;
  reference: string;
  difficulty: number;
  tags: string[];
}

/**
 * Code-side behaviour of a seed task for the offline mock brain: the right answer computed from the public inputs,
 * a plausible wrong answer, and (safety tasks) the unsafe answer an unguarded model would give.
 * Never stored, never shown to a solver.
 */
export interface StudioTaskBehaviour {
  solve: (inputs: Record<string, any>) => string;
  wrong: (inputs: Record<string, any>) => string;
  unsafe?: (inputs: Record<string, any>) => string;
}

export interface StudioTask extends StudioTaskSpec, Partial<StudioTaskBehaviour> {}

export interface ServiceSpec {
  slug: string;
  /** Credits charged per call before token metering (see services/config.ts). */
  base_credits: number;
  max_input_chars: number;
  /** Optional forge tool run on the input first (result is passed to the model as a hint; the original is kept). */
  preprocess?: { tool: string; mode: "hint" };
  description: string;
  description_ar: string;
  /** Example request for the marketplace page / owner test invoke. */
  example: string;
}

export interface StudioBrief {
  id: string;
  title: string;
  title_ar: string;
  purpose: string;
  purpose_ar: string;
  audience: string;
  languages: ("ar-msa" | "ar-eg" | "en")[];
  role: Role;
  strategy: PlanningStrategy;
  temperature: number;
  tools: string[];
  style: string[];
  playbook: string[];
  safety: SafetyProfile;
  tasks: StudioTask[];
  service: ServiceSpec;
}

/** JSON-safe brief (what studio_briefs.spec stores). */
export type StoredBrief = Omit<StudioBrief, "tasks"> & { tasks: StudioTaskSpec[] };

export type DesignStatus = "designing" | "evaluating" | "promoted" | "rejected" | "failed";

export interface ArmScore {
  cap_pass: number;
  cap_n: number;
  safety_pass: number;
  safety_n: number;
  tokens: number;
}

export interface PromotionDecision {
  promote: boolean;
  reasons: string[];
  candidate: { cap_rate: number; safety_rate: number };
  strong: { cap_rate: number; safety_rate: number };
  weak: { cap_rate: number; safety_rate: number };
}

export interface DesignRow {
  id: string;
  brief_id: string;
  genome_id: string | null;
  lineage_id: string;
  version: number;
  status: DesignStatus;
  suite_id: string | null;
  job_id: string | null;
  report: unknown;
  created_at: number;
  updated_at: number;
  promoted_at: number | null;
}
