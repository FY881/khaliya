/**
 * Baseline genomes used to validate new eval items.
 *  - STRONG: careful, plan-execute, low temperature, every good practice spelled out. A valid item
 *    must be solvable by it (otherwise the item is too hard → reserve).
 *  - WEAK:   first-guess, high temperature, no checking. A discriminative item must defeat it.
 *  - CRITIC: the Governor-side reviewer that sees the reference and judges item quality.
 * They are never written to the genomes table; their ids are content hashes like any genome.
 */
import type { Role } from "../constitution";
import { finalizeGenome, type Genome, type GenomeInput, type PlanningStrategy } from "../genome/schema";
import { GEMINI_FLASH, GEMINI_FLASH_LATEST, GEMINI_LITE, WORKERS_AI_SMALL, WORKERS_AI_STRONG } from "../llm/router";
import { PRACTICE_MARKERS } from "./mockBrain";

/**
 * Strong = the best free model available (Gemini 3.5 Flash → Flash latest → OpenRouter 70B → Flash-Lite → Workers AI 70B),
 * so Workers AI neurons are left for the weak baseline whenever Gemini answers; with no API keys
 * configured it still lands on a 70B model. Weak = a small current model, and it is PINNED (solveItem is
 * called with pinned=true): it may only use these small models and never falls back to the default chain.
 * Before 2026-10-12 the weak primary was a deprecated 8B model, so every weak call fell through to the same
 * 70B model as the strong baseline and the discriminative gate rejected almost every item.
 */
const STRONG_MODEL = { primary: GEMINI_FLASH, fallbacks: [GEMINI_FLASH_LATEST, "openrouter:meta-llama/llama-3.3-70b-instruct:free", GEMINI_LITE, WORKERS_AI_STRONG] };
const WEAK_MODEL = { primary: WORKERS_AI_SMALL[0], fallbacks: WORKERS_AI_SMALL.slice(1) };
/** Lineage id of the weak baseline: callers pin its model chain. */
export const WEAK_LINEAGE = "baseline-weak";

export const STRONG_PROMPT = [
  "You are a meticulous expert solver used as the strong reference baseline for evaluation items.",
  ...PRACTICE_MARKERS.map((m) => m.sentence),
  "Use only the information in the inputs and answer exactly in the requested format.",
].join(" ");

export const WEAK_PROMPT = "You are a hurried solver. Answer with your first guess immediately and do not look back at the inputs. Do not show any working.";

export const CRITIC_PROMPT = [
  "You are the Critic of an evaluation factory.",
  "You approve an item only if it is unambiguous, solvable from its inputs alone, graded correctly by its checker, and its reference answer is not leaked in the task or inputs.",
  "Judge the item exactly as written; it is a self-contained exercise, not production code, so hypothetical robustness concerns (input validation, other inputs it does not contain) are suggestions, never blocking issues.",
  "Verify the reference against the inputs and state any assumption you rely on.",
].join(" ");

function base(role: Role, name: string, prompt: string, strategy: PlanningStrategy, model: { primary: string; fallbacks: string[] }, temperature: number, tag: string): GenomeInput {
  return {
    lineage_id: `baseline-${tag}`,
    parent_ids: [],
    version: 1,
    role,
    name,
    system_prompt: prompt,
    planning_strategy: strategy,
    model_policy: { ...model, temperature },
    tool_ids: [],
    memory_policy: { working_k: 0, episodic_retention_days: 0, write_lessons: false },
    skills: [],
    eval_suites: [],
    budget_profile: {},
    mutation_log: [{ op: "seed", note: `${tag} validation baseline`, at: 0, by: "system" }],
    created_by: "system:baseline",
    created_at: 0,
  };
}

export const strongInput = (role: Role) => base(role, `Strong baseline (${role})`, STRONG_PROMPT, "plan-execute", STRONG_MODEL, 0.2, "strong");
export const weakInput = (role: Role) => base(role, `Weak baseline (${role})`, WEAK_PROMPT, "react", WEAK_MODEL, 0.9, "weak");
export const criticInput = () => base("critic", "Critic reviewer baseline", CRITIC_PROMPT, "reflexion", STRONG_MODEL, 0, "critic");

const cache = new Map<string, Promise<Genome>>();
const memo = (k: string, f: () => GenomeInput) => {
  if (!cache.has(k)) cache.set(k, finalizeGenome(f(), 0));
  return cache.get(k)!;
};

export const strongBaseline = (role: Role): Promise<Genome> => memo(`strong:${role}`, () => strongInput(role));
export const weakBaseline = (role: Role): Promise<Genome> => memo(`weak:${role}`, () => weakInput(role));
export const criticBaseline = (): Promise<Genome> => memo("critic", criticInput);

export async function baselines(role: Role): Promise<{ strong: Genome; weak: Genome }> {
  return { strong: await strongBaseline(role), weak: await weakBaseline(role) };
}
