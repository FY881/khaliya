import { CONSTITUTION, ROLES, type Role } from "../constitution";
import { canonicalJson, sha256Hex } from "../util";

export const PLANNING_STRATEGIES = ["react", "plan-execute", "reflexion", "tree-of-thought"] as const;
export type PlanningStrategy = (typeof PLANNING_STRATEGIES)[number];

export interface ModelPolicy {
  primary: string; // "provider:model"
  fallbacks: string[];
  temperature: number;
}
export interface MemoryPolicy {
  working_k: number; // memories retrieved per run
  episodic_retention_days: number;
  write_lessons: boolean;
}
export interface BudgetProfile {
  max_steps?: number;
  max_tokens?: number;
  max_tool_calls?: number;
  max_llm_calls?: number;
  max_wall_ms?: number;
  daily_runs?: number;
}
export interface MutationEntry {
  op: string;
  note?: string;
  at: number;
  by?: string;
}

export interface Genome {
  id: string;
  lineage_id: string;
  parent_ids: string[];
  version: number;
  role: Role;
  name: string;
  system_prompt: string;
  planning_strategy: PlanningStrategy;
  model_policy: ModelPolicy;
  tool_ids: string[];
  memory_policy: MemoryPolicy;
  skills: string[];
  eval_suites: string[];
  budget_profile: BudgetProfile;
  mutation_log: MutationEntry[];
  created_by: string;
  created_at: number;
}

/** Genome input before hashing (id / created_at are assigned). */
export type GenomeInput = Omit<Genome, "id" | "created_at"> & { id?: string; created_at?: number };

/** Fields excluded from the content hash: identity is the content, not when/what id it was given. */
const HASH_EXCLUDED = ["id", "created_at"] as const;

export function hashableBody(g: GenomeInput | Genome): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(g as Record<string, unknown>) };
  for (const k of HASH_EXCLUDED) delete body[k];
  return body;
}

export async function genomeId(g: GenomeInput | Genome): Promise<string> {
  const h = await sha256Hex(canonicalJson(hashableBody(g)));
  return `g_${h.slice(0, 32)}`;
}

export async function finalizeGenome(input: GenomeInput, at = Date.now()): Promise<Genome> {
  const normalized = normalizeGenome(input);
  const id = await genomeId(normalized);
  return { ...normalized, id, created_at: input.created_at ?? at } as Genome;
}

export async function verifyGenomeId(g: Genome): Promise<boolean> {
  return (await genomeId(g)) === g.id;
}

/** Fill defaults so equivalent inputs hash identically. */
export function normalizeGenome(input: GenomeInput): GenomeInput {
  return {
    ...input,
    parent_ids: [...(input.parent_ids ?? [])],
    model_policy: {
      primary: input.model_policy?.primary,
      fallbacks: [...(input.model_policy?.fallbacks ?? [])],
      temperature: input.model_policy?.temperature ?? 0.3,
    },
    tool_ids: [...new Set(input.tool_ids ?? [])].sort(),
    skills: [...(input.skills ?? [])],
    eval_suites: [...(input.eval_suites ?? [])],
    memory_policy: {
      working_k: input.memory_policy?.working_k ?? 6,
      episodic_retention_days: input.memory_policy?.episodic_retention_days ?? 30,
      write_lessons: input.memory_policy?.write_lessons ?? true,
    },
    budget_profile: { ...(input.budget_profile ?? {}) },
    mutation_log: [...(input.mutation_log ?? [])],
  } as GenomeInput;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

export function isFreeModel(model: string): boolean {
  if (!CONSTITUTION.allowedModelProviders.some((p) => model.startsWith(p))) return false;
  if (model.startsWith("openrouter:")) return model.endsWith(":free");
  return true;
}

export function validateGenome(g: unknown): ValidationResult {
  const e: string[] = [];
  const L = CONSTITUTION.genomeLimits;
  if (!g || typeof g !== "object") return { ok: false, errors: ["genome must be an object"] };
  const x = g as Record<string, any>;

  if (!isStr(x.lineage_id) || !/^[a-z0-9_-]{2,64}$/.test(x.lineage_id)) e.push("lineage_id: 2-64 chars [a-z0-9_-]");
  if (!isStr(x.name) || x.name.length < 1 || x.name.length > 80) e.push("name: 1-80 chars");
  if (!ROLES.includes(x.role)) e.push(`role: one of ${ROLES.join(", ")}`);
  if (!Number.isInteger(x.version) || x.version < 1) e.push("version: integer >= 1");
  if (!isStrArr(x.parent_ids) || x.parent_ids.length > 2) e.push("parent_ids: array of up to 2 genome ids");
  if (!isStr(x.system_prompt) || x.system_prompt.length < 10) e.push("system_prompt: at least 10 chars");
  else if (x.system_prompt.length > L.system_prompt_chars) e.push(`system_prompt: max ${L.system_prompt_chars} chars`);
  if (!PLANNING_STRATEGIES.includes(x.planning_strategy)) e.push(`planning_strategy: one of ${PLANNING_STRATEGIES.join(", ")}`);

  const mp = x.model_policy;
  if (!mp || typeof mp !== "object") e.push("model_policy: required");
  else {
    if (!isStr(mp.primary)) e.push("model_policy.primary: required");
    else if (!isFreeModel(mp.primary)) e.push(`model_policy.primary: '${mp.primary}' is not an allowed free model`);
    if (!isStrArr(mp.fallbacks)) e.push("model_policy.fallbacks: string[]");
    else for (const f of mp.fallbacks) if (!isFreeModel(f)) e.push(`model_policy.fallbacks: '${f}' is not an allowed free model`);
    if (typeof mp.temperature !== "number" || mp.temperature < 0 || mp.temperature > 2) e.push("model_policy.temperature: 0..2");
  }

  for (const [field, max] of [["tool_ids", L.tool_ids], ["skills", L.skills], ["eval_suites", L.eval_suites]] as const) {
    if (!isStrArr(x[field])) e.push(`${field}: string[]`);
    else if (x[field].length > max) e.push(`${field}: max ${max}`);
  }
  for (const ref of [...(isStrArr(x.tool_ids) ? x.tool_ids : []), ...(isStrArr(x.skills) ? x.skills : [])]) {
    if (CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => ref.startsWith(p))) e.push(`forbidden capability: '${ref}'`);
  }

  const mem = x.memory_policy;
  if (!mem || typeof mem !== "object") e.push("memory_policy: required");
  else {
    if (!Number.isInteger(mem.working_k) || mem.working_k < 0 || mem.working_k > 32) e.push("memory_policy.working_k: 0..32");
    if (!Number.isInteger(mem.episodic_retention_days) || mem.episodic_retention_days < 1 || mem.episodic_retention_days > 365)
      e.push("memory_policy.episodic_retention_days: 1..365");
    if (typeof mem.write_lessons !== "boolean") e.push("memory_policy.write_lessons: boolean");
  }

  const bp = x.budget_profile;
  if (!bp || typeof bp !== "object") e.push("budget_profile: required");
  else {
    const hard = CONSTITUTION.runHardCaps as Record<string, number>;
    for (const [k, v] of Object.entries(bp)) {
      if (k === "daily_runs") {
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 500) e.push("budget_profile.daily_runs: 0..500");
        continue;
      }
      if (!(k in hard)) e.push(`budget_profile.${k}: unknown cap`);
      else if (!Number.isInteger(v) || (v as number) < 1) e.push(`budget_profile.${k}: positive integer`);
      else if ((v as number) > hard[k]) e.push(`budget_profile.${k}: exceeds constitutional cap ${hard[k]}`);
    }
  }

  if (!Array.isArray(x.mutation_log) || x.mutation_log.length > L.mutation_log) e.push(`mutation_log: array (max ${L.mutation_log})`);
  else for (const m of x.mutation_log) if (!m || !isStr(m.op) || typeof m.at !== "number") e.push("mutation_log entry: {op, at}");
  if (!isStr(x.created_by) || !x.created_by) e.push("created_by: required");

  if (new TextEncoder().encode(canonicalJson(x)).length > L.body_bytes) e.push(`genome too large (max ${L.body_bytes} bytes)`);
  return { ok: e.length === 0, errors: e };
}
