// Mutation operators for the evolution loop.
//
// Every operator is deterministic given its inputs (pass `ctx.at` for a fixed timestamp and a seeded
// rng), never mutates its arguments, and returns a NEW, schema-validated, content-hashed genome:
//   new id/hash, version + 1, parent_ids = [parent(s)], one mutation_log entry {op, at, note, by}.
// Operators throw OperatorError when the mutation is impossible or would be a no-op, so the caller
// can record a bandit failure and try another arm.
import { CONSTITUTION, type Role } from "../constitution";
import {
  finalizeGenome,
  isFreeModel,
  PLANNING_STRATEGIES,
  validateGenome,
  type Genome,
  type GenomeInput,
  type ModelPolicy,
  type MutationEntry,
} from "../genome/schema";
import { DEFAULT_CHAIN } from "../llm/router";
import { TOOL_MAP } from "../tools/catalog";
import { fnv1a, normalizeText, similarity } from "../eval/text";
import type { Rng } from "./bandit";

export const OPERATORS = [
  "prompt_rewrite",
  "strategy_swap",
  "tool_add",
  "tool_remove",
  "model_policy_change",
  "crossover",
  "distill",
  "spawn_role",
] as const;
export type OperatorId = (typeof OPERATORS)[number];

export interface OpContext {
  /** Timestamp for created_at and the mutation_log entry. Defaults to Date.now(). */
  at?: number;
  /** Who/what proposed the mutation (goes into created_by and mutation_log.by). */
  by?: string;
}

export class OperatorError extends Error {
  constructor(
    readonly op: OperatorId,
    message: string,
  ) {
    super(`${op}: ${message}`);
    this.name = "OperatorError";
  }
}

/** Free, non-mock models evolution may choose from. */
export const FREE_MODEL_POOL: readonly string[] = Object.freeze(
  [...new Set(DEFAULT_CHAIN)].filter((m) => isFreeModel(m) && !m.startsWith("mock:")),
);

export const LEARNED_HEADER = "## Learned practices";
export interface DistillLimits {
  maxLessons: number;
  maxLessonChars: number;
}
export const DISTILL_LIMITS: Readonly<DistillLimits> = Object.freeze({ maxLessons: 8, maxLessonChars: 240 });

const MUTATION_LOG_MAX = CONSTITUTION.genomeLimits.mutation_log;

function strip(g: Genome | GenomeInput): GenomeInput {
  const { id: _id, created_at: _c, ...rest } = g as Genome;
  return structuredClone(rest) as GenomeInput;
}

function entry(op: OperatorId, note: string, ctx: OpContext): MutationEntry {
  return { op, note: note.slice(0, 300), at: ctx.at ?? Date.now(), by: ctx.by ?? "evolution" };
}

function appendLog(log: MutationEntry[], e: MutationEntry): MutationEntry[] {
  return [...log, e].slice(-MUTATION_LOG_MAX);
}

async function seal(op: OperatorId, input: GenomeInput, ctx: OpContext): Promise<Genome> {
  const v = validateGenome(input);
  if (!v.ok) throw new OperatorError(op, `invalid result: ${v.errors.join("; ")}`);
  const at = ctx.at ?? Date.now();
  return finalizeGenome({ ...input, created_at: at }, at);
}

/** Child of a single parent with `changes` applied. */
async function derive(op: OperatorId, parent: Genome, changes: Partial<GenomeInput>, note: string, ctx: OpContext): Promise<Genome> {
  const base = strip(parent);
  const e = entry(op, note, ctx);
  return seal(
    op,
    {
      ...base,
      ...changes,
      version: parent.version + 1,
      parent_ids: [parent.id],
      mutation_log: appendLog(base.mutation_log, e),
      created_by: ctx.by ?? "evolution",
    },
    ctx,
  );
}

export function isForbiddenRef(ref: string): boolean {
  return CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => ref.startsWith(p));
}

/** Can `role` carry tool `toolId`? (known tool, not forbidden, tier within the role ceiling) */
export function toolAllowedForRole(toolId: string, role: Role): { ok: boolean; reason?: string } {
  if (isForbiddenRef(toolId)) return { ok: false, reason: `forbidden capability '${toolId}'` };
  const t = TOOL_MAP[toolId];
  if (!t) return { ok: false, reason: `unknown tool '${toolId}'` };
  const max = CONSTITUTION.roleMaxTier[role];
  if (t.tier > max) return { ok: false, reason: `tool '${toolId}' is T${t.tier}, above ${role} ceiling T${max}` };
  return { ok: true };
}

// ---------------------------------------------------------------- 1. prompt_rewrite
export async function prompt_rewrite(parent: Genome, newPrompt: string, ctx: OpContext = {}): Promise<Genome> {
  const p = String(newPrompt ?? "").trim();
  if (p.length < 10) throw new OperatorError("prompt_rewrite", "new prompt too short");
  if (p.length > CONSTITUTION.genomeLimits.system_prompt_chars)
    throw new OperatorError("prompt_rewrite", `new prompt exceeds ${CONSTITUTION.genomeLimits.system_prompt_chars} chars`);
  if (p === parent.system_prompt.trim()) throw new OperatorError("prompt_rewrite", "prompt unchanged");
  const sim = similarity(parent.system_prompt, p);
  return derive(
    "prompt_rewrite",
    parent,
    { system_prompt: p },
    `prompt ${parent.system_prompt.length}→${p.length} chars, similarity ${sim.toFixed(2)}`,
    ctx,
  );
}

// ---------------------------------------------------------------- 2. strategy_swap
export async function strategy_swap(parent: Genome, rng: Rng, ctx: OpContext = {}): Promise<Genome> {
  const others = PLANNING_STRATEGIES.filter((s) => s !== parent.planning_strategy);
  const next = others[Math.floor(rng() * others.length)]!;
  return derive("strategy_swap", parent, { planning_strategy: next }, `${parent.planning_strategy}→${next}`, ctx);
}

// ---------------------------------------------------------------- 3. tool_add / tool_remove
export async function tool_add(parent: Genome, toolId: string, ctx: OpContext = {}): Promise<Genome> {
  const ok = toolAllowedForRole(toolId, parent.role);
  if (!ok.ok) throw new OperatorError("tool_add", ok.reason!);
  if (parent.tool_ids.includes(toolId)) throw new OperatorError("tool_add", `already has '${toolId}'`);
  if (parent.tool_ids.length >= CONSTITUTION.genomeLimits.tool_ids)
    throw new OperatorError("tool_add", `tool limit ${CONSTITUTION.genomeLimits.tool_ids} reached`);
  return derive("tool_add", parent, { tool_ids: [...parent.tool_ids, toolId] }, `+${toolId} (T${TOOL_MAP[toolId]!.tier})`, ctx);
}

export async function tool_remove(parent: Genome, toolId: string, ctx: OpContext = {}): Promise<Genome> {
  if (!parent.tool_ids.includes(toolId)) throw new OperatorError("tool_remove", `does not have '${toolId}'`);
  if (parent.tool_ids.length <= 1) throw new OperatorError("tool_remove", "cannot remove the last tool");
  return derive("tool_remove", parent, { tool_ids: parent.tool_ids.filter((t) => t !== toolId) }, `-${toolId}`, ctx);
}

/** Tools the parent could gain (sorted, deterministic) — handy for choosing a tool_add argument. */
export function addableTools(parent: Genome): string[] {
  return Object.keys(TOOL_MAP)
    .filter((t) => !parent.tool_ids.includes(t) && toolAllowedForRole(t, parent.role).ok)
    .sort();
}

// ---------------------------------------------------------------- 4. model_policy_change
const round2 = (x: number) => Math.round(x * 100) / 100;

export async function model_policy_change(
  parent: Genome,
  rng: Rng,
  ctx: OpContext = {},
  pool: readonly string[] = FREE_MODEL_POOL,
): Promise<Genome> {
  const free = [...new Set(pool)].filter((m) => isFreeModel(m) && !m.startsWith("mock:"));
  if (free.length === 0) throw new OperatorError("model_policy_change", "no free models in pool");
  const cur = parent.model_policy;
  const kinds: ("primary" | "fallbacks" | "temperature")[] = [];
  if (free.some((m) => m !== cur.primary)) kinds.push("primary");
  if (cur.fallbacks.length >= 2 || free.some((m) => m !== cur.primary && !cur.fallbacks.includes(m))) kinds.push("fallbacks");
  kinds.push("temperature");
  const kind = kinds[Math.floor(rng() * kinds.length)]!;

  let next: ModelPolicy;
  let note: string;
  if (kind === "primary") {
    const choices = free.filter((m) => m !== cur.primary);
    const primary = choices[Math.floor(rng() * choices.length)]!;
    // demote the old primary to the head of the fallbacks if it is still a free model
    const demoted = isFreeModel(cur.primary) && !cur.primary.startsWith("mock:") ? [cur.primary] : [];
    const fallbacks = [...new Set([...demoted, ...cur.fallbacks])].filter((m) => m !== primary && isFreeModel(m)).slice(0, 4);
    next = { primary, fallbacks, temperature: cur.temperature };
    note = `primary ${cur.primary}→${primary}`;
  } else if (kind === "fallbacks") {
    const unused = free.filter((m) => m !== cur.primary && !cur.fallbacks.includes(m));
    let fallbacks: string[];
    if (unused.length > 0 && (cur.fallbacks.length < 2 || rng() < 0.5)) {
      const add = unused[Math.floor(rng() * unused.length)]!;
      fallbacks = [...cur.fallbacks, add].slice(-4);
      note = `fallback +${add}`;
    } else {
      // rotate: move a random non-head fallback to the front
      const i = 1 + Math.floor(rng() * (cur.fallbacks.length - 1));
      fallbacks = [cur.fallbacks[i]!, ...cur.fallbacks.filter((_, j) => j !== i)];
      note = `fallback order: ${fallbacks[0]} first`;
    }
    next = { primary: cur.primary, fallbacks: fallbacks.filter(isFreeModel), temperature: cur.temperature };
  } else {
    const mag = 0.1 + round2(Math.floor(rng() * 3) / 10); // 0.1 | 0.2 | 0.3
    let dir = rng() < 0.5 ? -1 : 1;
    if (cur.temperature - mag < 0) dir = 1;
    if (cur.temperature + mag > 1.5) dir = -1;
    const temperature = round2(Math.min(1.5, Math.max(0, cur.temperature + dir * mag)));
    next = { primary: cur.primary, fallbacks: [...cur.fallbacks], temperature };
    note = `temperature ${cur.temperature}→${temperature}`;
  }
  if (JSON.stringify(next) === JSON.stringify(cur)) throw new OperatorError("model_policy_change", "policy unchanged");
  return derive("model_policy_change", parent, { model_policy: next }, note, ctx);
}

// ---------------------------------------------------------------- 5. crossover
export const CROSSOVER_FIELDS = [
  "system_prompt",
  "planning_strategy",
  "model_policy",
  "tool_ids",
  "memory_policy",
  "skills",
  "eval_suites",
  "budget_profile",
] as const;
type CrossField = (typeof CROSSOVER_FIELDS)[number];

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** Field-wise uniform crossover of two same-role genomes. The child stays in `a`'s lineage. */
export async function crossover(a: Genome, b: Genome, rng: Rng, ctx: OpContext = {}): Promise<Genome> {
  if (a.id === b.id) throw new OperatorError("crossover", "parents are identical");
  if (a.role !== b.role) throw new OperatorError("crossover", `role mismatch ${a.role} vs ${b.role}`);
  const differing = CROSSOVER_FIELDS.filter((f) => !same(a[f], b[f]));
  if (differing.length === 0) throw new OperatorError("crossover", "parents have identical content");

  const picks: Record<CrossField, "a" | "b"> = {} as Record<CrossField, "a" | "b">;
  for (const f of CROSSOVER_FIELDS) picks[f] = rng() < 0.5 ? "a" : "b";
  // The child must differ from both parents: with ≥2 differing fields keep at least one from each;
  // with exactly one differing field take b's (child = a's lineage carrying b's trait).
  const pickIdx = () => Math.floor(rng() * differing.length);
  if (differing.length === 1) picks[differing[0]!] = "b";
  else {
    if (differing.every((f) => picks[f] === "a")) picks[differing[pickIdx()]!] = "b";
    if (differing.every((f) => picks[f] === "b")) picks[differing[pickIdx()]!] = "a";
  }

  const base = strip(a);
  const child: GenomeInput = { ...base };
  for (const f of CROSSOVER_FIELDS) (child as any)[f] = structuredClone((picks[f] === "a" ? a : b)[f]);
  child.tool_ids = child.tool_ids.filter((t) => toolAllowedForRole(t, a.role).ok);
  const tookB = CROSSOVER_FIELDS.filter((f) => picks[f] === "b" && !same(a[f], b[f]));
  const e = entry("crossover", `${a.id.slice(0, 10)}×${b.id.slice(0, 10)}; from b: ${tookB.join(",")}`, ctx);
  return seal(
    "crossover",
    {
      ...child,
      version: Math.max(a.version, b.version) + 1,
      parent_ids: [a.id, b.id],
      mutation_log: appendLog(base.mutation_log, e),
      created_by: ctx.by ?? "evolution",
    },
    ctx,
  );
}

// ---------------------------------------------------------------- 6. distill
function cleanLesson(s: string, maxChars: number): string {
  return String(s ?? "")
    .replace(/^[\s\-*•\d.)]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** Split a prompt into its body and the bullets of its Learned practices section (if any). */
export function splitLearned(prompt: string): { body: string; lessons: string[] } {
  const i = prompt.indexOf(LEARNED_HEADER);
  if (i < 0) return { body: prompt.trimEnd(), lessons: [] };
  const lessons = prompt
    .slice(i + LEARNED_HEADER.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  return { body: prompt.slice(0, i).trimEnd(), lessons };
}

const renderLearned = (body: string, lessons: string[]) =>
  lessons.length ? `${body}\n\n${LEARNED_HEADER}\n${lessons.map((l) => `- ${l}`).join("\n")}` : body;

/**
 * Append distilled lessons as a bounded "Learned practices" section. Near-duplicate lessons
 * (shingle similarity ≥ 0.8 or identical after normalisation) are dropped; the section keeps the
 * newest `maxLessons`, and oldest lessons are dropped further if the prompt would exceed the limit.
 */
export async function distill(
  parent: Genome,
  lessons: string[],
  ctx: OpContext = {},
  limits: Partial<DistillLimits> = {},
): Promise<Genome> {
  const { maxLessons, maxLessonChars } = { ...DISTILL_LIMITS, ...limits };
  const { body, lessons: existing } = splitLearned(parent.system_prompt);
  const kept = [...existing];
  const added: string[] = [];
  for (const raw of lessons) {
    const l = cleanLesson(raw, maxLessonChars);
    if (l.length < 4) continue;
    const dup = kept.some((k) => normalizeText(k) === normalizeText(l) || similarity(k, l) >= 0.8);
    if (dup) continue;
    kept.push(l);
    added.push(l);
  }
  if (added.length === 0) throw new OperatorError("distill", "no new lessons");
  let section = kept.slice(-maxLessons);
  const max = CONSTITUTION.genomeLimits.system_prompt_chars;
  while (section.length > 0 && renderLearned(body, section).length > max) section = section.slice(1);
  const survived = added.filter((l) => section.includes(l));
  if (survived.length === 0) throw new OperatorError("distill", "no room for new lessons");
  const prompt = renderLearned(body, section);
  return derive("distill", parent, { system_prompt: prompt }, `+${survived.length} lessons (${section.length} total)`, ctx);
}

// ---------------------------------------------------------------- 7. spawn_role
export function lineageSlug(name: string): string {
  const s = normalizeText(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s.length >= 2 ? s : `role-${fnv1a(name).toString(16)}`;
}

export interface SpawnOptions {
  /** Constitutional role of the new agent (defaults to the template's role). */
  role?: Role;
  /** Explicit lineage id (defaults to a slug of roleName). */
  lineageId?: string;
  /** Explicit prompt (defaults to the template prompt re-addressed to the new role name). */
  prompt?: string;
}

/** Start a NEW lineage (version 1) from a template genome, renamed for a new specialist role. */
export async function spawn_role(template: Genome, roleName: string, ctx: OpContext = {}, opts: SpawnOptions = {}): Promise<Genome> {
  const name = String(roleName ?? "").trim().slice(0, 80);
  if (!name) throw new OperatorError("spawn_role", "role name required");
  const role = opts.role ?? template.role;
  const lineage_id = opts.lineageId ?? lineageSlug(name);
  if (lineage_id === template.lineage_id) throw new OperatorError("spawn_role", "new lineage must differ from the template's");
  let prompt = opts.prompt?.trim();
  if (!prompt) {
    const { body } = splitLearned(template.system_prompt);
    const rest = body.replace(/^You are (the |an? )?[^.]{1,80}\.\s*/i, "");
    prompt = `You are the ${name}. ${rest}`.trim();
  }
  const base = strip(template);
  const tool_ids = base.tool_ids.filter((t) => toolAllowedForRole(t, role).ok);
  return seal(
    "spawn_role",
    {
      ...base,
      lineage_id,
      role,
      name,
      system_prompt: prompt,
      tool_ids,
      version: 1,
      parent_ids: [template.id],
      mutation_log: [entry("spawn_role", `new lineage '${lineage_id}' (${role}) from ${template.lineage_id}@v${template.version}`, ctx)],
      created_by: ctx.by ?? "evolution",
    },
    ctx,
  );
}

