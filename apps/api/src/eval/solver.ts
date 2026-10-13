/**
 * Solve an eval item with a genome through the LabLLM (budgeted, kill-switch aware).
 * The solver's input type excludes `reference`, and the prompt carries only task, inputs, difficulty and
 * a format hint, so a solver can never see the reference solution.
 */
import type { Genome } from "../genome/schema";
import { extractJson } from "../util";
import { judge, type JudgeOptions, type JudgeResult } from "./judge";
import type { LabLLM } from "./llm";
import { solveMessages } from "./prompts";
import type { ItemSpec } from "./types";
import { WEAK_LINEAGE } from "./baselines";

/** The weak validation baseline is always pinned to its small models. */
const isPinned = (g: SolverGenome) => (g as { lineage_id?: string }).lineage_id === WEAK_LINEAGE;

export type SolvableItem = Pick<ItemSpec, "task" | "inputs" | "checker" | "difficulty">;
export type SolverGenome = Pick<Genome, "id" | "system_prompt" | "planning_strategy" | "skills" | "role" | "model_policy"> & { lineage_id?: string };

export interface Solution {
  answer: string;
  raw: string;
  tokens: number;
  model?: string;
}

const answerString = (a: unknown): string => {
  if (typeof a === "string") return a;
  if (a === null || a === undefined) return "";
  return typeof a === "number" || typeof a === "boolean" ? String(a) : JSON.stringify(a);
};

/** Every balanced {...} object in the text (string-aware), in order of appearance. */
function jsonObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf("{"); i >= 0 && out.length < 50; i = text.indexOf("{", i + 1)) {
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.push(text.slice(i, j + 1));
        break;
      }
    }
  }
  return out;
}

/**
 * Turn the solver's reply into the answer string a checker grades. Real models do not always reply with one
 * clean JSON object: they wrap it in prose or a code fence, emit their plan first, or drop the braces
 * (`"answer": 42`). The answer is taken from (1) the whole reply as JSON, (2) the LAST JSON object that has
 * an "answer" key, (3) a bare `"answer": value` pair; otherwise the trimmed reply. This only recovers what the
 * model actually answered — it never infers an answer, so it cannot make a wrong reply pass.
 */
export function parseAnswer(raw: string): string {
  const has = (j: unknown): j is { answer: unknown } => !!j && typeof j === "object" && !Array.isArray(j) && "answer" in (j as object);
  const direct = extractJson<unknown>(raw.trim());
  if (has(direct)) return answerString(direct.answer);
  const objs = jsonObjects(raw);
  for (let k = objs.length - 1; k >= 0; k--) {
    try {
      const j = JSON.parse(objs[k]);
      if (has(j)) return answerString(j.answer);
    } catch {}
  }
  const bare = raw.match(/"answer"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)/i);
  if (bare) {
    try {
      return answerString(JSON.parse(bare[1]));
    } catch {}
  }
  return raw.trim();
}

export interface SolveOptions {
  agentId?: string;
  /** Use only the genome's own models (no default-chain fallback). Set for the weak baseline. */
  pinned?: boolean;
}

export async function solveItem(lab: LabLLM, genome: SolverGenome, item: SolvableItem, opts: SolveOptions = {}): Promise<Solution> {
  // Defensive copy of the public fields only: even if a caller passes a full EvalItem, the reference stays out.
  const pub: SolvableItem = { task: item.task, inputs: item.inputs, checker: item.checker, difficulty: item.difficulty };
  const res = await lab.complete(
    opts.agentId ?? `lab:solver:${genome.id}`,
    { messages: solveMessages(genome, pub), temperature: genome.model_policy.temperature, json: true, maxTokens: 1200 },
    genome.model_policy,
    { pinned: opts.pinned ?? isPinned(genome) },
  );
  return { answer: parseAnswer(res.text), raw: res.text, tokens: res.tokensIn + res.tokensOut, model: res.model };
}

export interface Attempt extends Solution {
  verdict: JudgeResult;
}

/** Solve, then grade (the grader may see the reference; the solver did not). */
export async function attempt(lab: LabLLM, genome: SolverGenome, item: SolvableItem & Partial<Pick<ItemSpec, "reference">>, judgeOpts: JudgeOptions = {}, solveOpts: SolveOptions = {}): Promise<Attempt> {
  const sol = await solveItem(lab, genome, item, solveOpts);
  const verdict = await judge(item, sol.answer, lab, judgeOpts);
  return { ...sol, verdict };
}
