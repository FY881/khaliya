import type { Role } from "../constitution";

export type Split = "public" | "private" | "canary";
export type ItemStatus = "pending" | "active" | "reserve" | "rejected" | "retired";
export const SPLITS: Split[] = ["public", "private", "canary"];

export interface ExactChecker {
  type: "exact";
  value: string;
  case_sensitive?: boolean;
}
export interface RegexChecker {
  type: "regex";
  pattern: string;
  flags?: string;
  must_not?: string;
}
export interface JsonSchemaChecker {
  type: "json_schema";
  schema: JsonSchema;
  equals?: unknown;
}
export interface NumericChecker {
  type: "numeric";
  value: number;
  tolerance?: number; // absolute
  rel_tolerance?: number;
}
export interface ContainsChecker {
  type: "contains";
  all?: string[];
  any?: string[];
  none?: string[];
  max_length?: number;
  case_sensitive?: boolean;
}
export interface RubricCriterion {
  id: string;
  desc: string;
  weight?: number;
  /** Concrete evidence the criterion asks for. Judges see it; the deterministic mock judge matches on it. */
  keywords?: string[];
  /** Evidence that must NOT appear (e.g. listing things that are not actually missing). */
  avoid?: string[];
}
export interface RubricChecker {
  type: "rubric";
  criteria: RubricCriterion[];
  pass_threshold?: number; // weighted score 0..1, default 0.7
  max_length?: number;
}
export type Checker = ExactChecker | RegexChecker | JsonSchemaChecker | NumericChecker | ContainsChecker | RubricChecker;
export const CHECKER_TYPES = ["exact", "regex", "json_schema", "numeric", "contains", "rubric"] as const;

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** What an author submits. */
export interface ItemSpec {
  suite_id: string;
  task: string;
  inputs: Record<string, unknown>;
  checker: Checker;
  reference: string;
  difficulty: number;
  tags: string[];
  split: Split;
}

export interface EvalItem extends ItemSpec {
  id: string;
  role: Role;
  status: ItemStatus;
  quality: number | null;
  norm_hash: string;
  validation: ValidationReport | null;
  author: string;
  author_lineage: string | null;
  checks: number;
  flakes: number;
  status_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface Verdict {
  pass: boolean;
  score: number; // 0..1
  method: "deterministic" | "panel";
  agreement: number; // 0..1 (1 for deterministic)
  detail?: string;
  judges?: { model: string; score: number; flags?: string[] }[];
}

export interface StageResult {
  ok: boolean;
  detail?: string;
  data?: unknown;
}

export interface ValidationReport {
  at: number;
  outcome: "active" | "reserve" | "rejected";
  reason?: string;
  stages: Record<string, StageResult>;
  quality?: number;
  llm_calls?: number;
}
