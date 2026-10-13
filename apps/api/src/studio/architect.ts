/**
 * Studio architect: brief → genome.
 *
 * Live mode asks a free model (through the LabLLM, so the lab budget, kill switch and caps apply) to write the
 * agent's working prompt from the brief. Mock mode uses a deterministic template built from the same brief, so
 * tests and offline runs need no LLM. Either way the safety block is appended by CODE afterwards (never by the
 * model) and the result goes through `constitutionCheck` before anything is evaluated: an LLM draft that asks for
 * autonomy, drops Arabic, or is too long is discarded in favour of the template.
 */
import { LabBudgetError, type LabLLM } from "../eval/llm";
import { finalizeGenome, type Genome, type GenomeInput } from "../genome/schema";
import { GEMINI_FLASH, GEMINI_FLASH_LATEST, GEMINI_LITE, WORKERS_AI_STRONG } from "../llm/router";
import { extractJson } from "../util";
import { CONSTITUTION } from "../constitution";
import { suiteIdOf } from "./briefs";
import { constitutionCheck, safetyBlock, SAFETY_MARKER, t4Like, type ConstitutionReport } from "./guardrails";
import { hasArabic } from "./text";
import { arNorm } from "../eval/synonyms";
import type { StudioBrief } from "./types";
import { bodyOf, CRAFT_MARKER, craftBlock, refineMessages, REVISION_MARKER, revisionNotes, type RefineFailure } from "./craft";

/**
 * Reply budget for architect/refiner calls. 1800 tokens cut long Arabic prompts mid-JSON (Arabic costs ~1 token per
 * 2–3 chars, plus JSON escaping); extractJson then returned null and the draft was reported as "too short" (live
 * research-summarizer refinements, 2026-10-13). Tokens are not the binding free-tier limit (calls are).
 */
export const ARCHITECT_MAX_TOKENS = 3600;

/**
 * Parse an architect/refiner reply into a draft, with a precise reason when it can't (so a live report says WHY:
 * cut off at the token limit, not JSON, or no system_prompt) instead of lumping everything into "too short".
 */
export function parseDraft(text: string): { prompt?: string; note?: string; problem?: string } {
  const j = extractJson<{ system_prompt?: unknown; note?: unknown }>(text ?? "");
  if (!j) return { problem: /"system_prompt"\s*:/.test(text ?? "") ? "reply cut off (unterminated JSON)" : "reply is not JSON" };
  if (typeof j.system_prompt !== "string") return { problem: "reply has no system_prompt string" };
  return { prompt: j.system_prompt, note: typeof j.note === "string" ? j.note : undefined };
}

export const STUDIO_ACTOR = "system:studio";
export const ARCHITECT_AGENT = "lab:studio:architect";
/** Free model chain for designed service agents (same order as the strong baseline). */
export const STUDIO_MODEL_POLICY = {
  primary: GEMINI_FLASH,
  fallbacks: [GEMINI_FLASH_LATEST, "openrouter:meta-llama/llama-3.3-70b-instruct:free", GEMINI_LITE, WORKERS_AI_STRONG],
};
/** Architect body budget: body + revision notes + craft + safety block must fit CONSTITUTION's 8000-char prompt limit. */
export const MAX_BODY_CHARS = 3500;

const LANG_LABEL: Record<string, string> = { "ar-msa": "العربية الفصحى", "ar-eg": "العامية المصرية", en: "English" };

export const lineageOf = (briefId: string) => `studio-${briefId}`.slice(0, 64);

/** Deterministic working prompt (everything except the safety block). */
export function templatePrompt(b: StudioBrief): string {
  const langs = b.languages.map((l) => LANG_LABEL[l] ?? l).join("، ");
  return [
    `أنت «${b.title_ar}» (${b.title}) في منظمة خلية.`,
    `مهمتك: ${b.purpose_ar}`,
    `Mission: ${b.purpose}`,
    `جمهورك: ${b.audience}`,
    `اللغات: ${langs}. ردّ بلغة المستخدم ولهجته.`,
    "أسلوبك:",
    ...b.style.map((s) => `- ${s}`),
    "طريقة العمل:",
    ...b.playbook.map((s, i) => `${i + 1}. ${s}`),
    "Work step by step, re-read the question before answering, and keep the final answer concise and in the requested format.",
  ].join("\n");
}

export function architectMessages(b: StudioBrief) {
  return [
    {
      role: "system" as const,
      content:
        "You are the Architect of the Khaliya agent organization. You write the working system prompt for a new customer-facing service agent. " +
        "Write it MAINLY IN ARABIC (Arabic sentences first; an English line is fine) — an English-only prompt is rejected. Focus on how the agent structures concrete, short, complete answers for this audience. Do not write any safety rules (they are appended separately by code), do not grant any autonomy, tools, spending or approval power. Reply with JSON only.",
    },
    {
      role: "user" as const,
      content: [
        "MODE: studio_architect",
        `BRIEF: ${JSON.stringify({ title: b.title, title_ar: b.title_ar, purpose: b.purpose, purpose_ar: b.purpose_ar, audience: b.audience, languages: b.languages, style: b.style, playbook: b.playbook })}`,
        `Return {"system_prompt": "<= ${MAX_BODY_CHARS} chars", "note": "<one line on what you emphasised>"}.`,
      ].join("\n"),
    },
  ];
}

export interface ArchitectResult {
  genome: GenomeInput;
  genome_id: string;
  source: "template" | "llm";
  note: string;
  check: ConstitutionReport;
}

/** Why an LLM draft is rejected (null = acceptable). */
export function draftProblem(text: unknown, b?: StudioBrief, revision?: string): string | null {
  if (typeof text !== "string") return "draft missing";
  if (text.trim().length < 80) return `draft too short (${text.trim().length} chars)`;
  if (text.length > MAX_BODY_CHARS) return "draft too long";
  if (!hasArabic(text)) return "draft is not Arabic-first";
  if (t4Like(text)) return "draft asks for autonomy / approval bypass";
  if (text.includes(SAFETY_MARKER)) return "draft writes its own safety block";
  if (text.includes(CRAFT_MARKER) || text.includes(REVISION_MARKER)) return "draft writes a code-appended block";
  if (b && composePrompt(b, text, revision).length > CONSTITUTION.genomeLimits.system_prompt_chars) return "composed prompt too long";
  if (b && copiesTask(text, b)) return "draft copies eval task text";
  return null;
}

/** Window (in words) of task text that a draft may not repeat verbatim. */
export const TASK_COPY_WINDOW = 7;

/**
 * True when a draft repeats any TASK_COPY_WINDOW-word run of one of the brief's eval task texts or reference answers.
 * Live finding 2026-10-13: a research-summarizer refinement pasted the failing task's own wording into the prompt.
 * The refiner sees task text (it must, to know what went wrong) — this keeps it from turning that into a test-shaped prompt.
 */
export function copiesTask(text: string, b: Pick<StudioBrief, "tasks">): boolean {
  const w = (s: string) => arNorm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const hay = ` ${w(text).join(" ")} `;
  for (const t of b.tasks)
    for (const src of [t.task, t.reference]) {
      const ws = w(src);
      for (let i = 0; i + TASK_COPY_WINDOW <= ws.length; i++) if (hay.includes(` ${ws.slice(i, i + TASK_COPY_WINDOW).join(" ")} `)) return true;
    }
  return false;
}

/** Working prompt layout: architect body, [revision notes], answer craft, safety block (always last). */
export function composePrompt(b: StudioBrief, body: string, revision?: string): string {
  return [body.trim(), revision?.trim(), craftBlock(b), safetyBlock(b.safety)].filter(Boolean).join("\n\n");
}

export function assembleGenome(b: StudioBrief, body: string, opts: { version: number; note: string; at?: number; revision?: string; op?: string }): GenomeInput {
  return {
    lineage_id: lineageOf(b.id),
    parent_ids: [],
    version: Math.max(1, opts.version),
    role: b.role,
    name: `${b.title}`.slice(0, 80),
    system_prompt: composePrompt(b, body, opts.revision),
    planning_strategy: b.strategy,
    model_policy: { ...STUDIO_MODEL_POLICY, fallbacks: [...STUDIO_MODEL_POLICY.fallbacks], temperature: b.temperature },
    tool_ids: [...b.tools],
    memory_policy: { working_k: 0, episodic_retention_days: 30, write_lessons: false },
    skills: b.playbook.slice(0, 24),
    eval_suites: [suiteIdOf(b.id)],
    budget_profile: { max_steps: 4, max_tool_calls: 3, max_llm_calls: 6 },
    mutation_log: [{ op: opts.op ?? "studio.design", note: opts.note.slice(0, 200), at: opts.at ?? Date.now(), by: STUDIO_ACTOR }],
    created_by: STUDIO_ACTOR,
  };
}

/**
 * Design a genome for a brief. Live mode spends at most ONE lab call; mock mode none.
 * LabBudgetError propagates (the job runner stops cleanly); any other LLM failure falls back to the template.
 */
export async function architect(b: StudioBrief, lab: LabLLM | null, opts: { version?: number; at?: number } = {}): Promise<ArchitectResult> {
  let body = templatePrompt(b);
  let source: ArchitectResult["source"] = "template";
  let note = "template";
  if (lab && lab.mode !== "mock") {
    try {
      const res = await lab.complete(ARCHITECT_AGENT, { messages: architectMessages(b), temperature: 0.3, json: true, maxTokens: ARCHITECT_MAX_TOKENS });
      const d = parseDraft(res.text);
      const problem = d.problem ?? draftProblem(d.prompt, b);
      if (!problem) {
        body = String(d.prompt);
        source = "llm";
        note = d.note ?? `llm draft (${res.model})`;
      } else note = `template (llm draft rejected: ${problem}; ${res.model}, ${res.tokensOut} tokens out)`;
    } catch (e) {
      if (e instanceof LabBudgetError) throw e;
      note = `template (llm error: ${String((e as Error)?.message ?? e).slice(0, 120)})`;
    }
  }
  const genome = assembleGenome(b, body, { version: opts.version ?? 1, note, at: opts.at });
  const check = constitutionCheck(b, genome);
  const g: Genome = await finalizeGenome(genome, opts.at ?? Date.now());
  return { genome, genome_id: g.id, source, note, check };
}

export interface RefineResult extends ArchitectResult {
  round: number;
}

/**
 * Revise a rejected candidate from abstract failure feedback (see craft.ts: the refiner never sees reference
 * answers or checker keywords). Live: ≤ 1 lab call; the revised body must pass draftProblem, else the previous body
 * is kept with deterministic revision notes. Mock: deterministic notes only. Safety/craft blocks are re-appended by
 * code and the result goes through constitutionCheck again.
 */
export async function refine(
  b: StudioBrief,
  prev: GenomeInput,
  failures: RefineFailure[],
  lab: LabLLM | null,
  opts: { round: number; version?: number; at?: number },
): Promise<RefineResult> {
  const body0 = bodyOf(prev.system_prompt, [REVISION_MARKER, CRAFT_MARKER, SAFETY_MARKER]);
  let body = body0;
  let source: ArchitectResult["source"] = "template";
  let note = `refine r${opts.round}: revision notes`;
  let revision: string | undefined = revisionNotes(failures, opts.round, b.safety.domain);
  if (lab && lab.mode !== "mock") {
    try {
      const res = await lab.complete(ARCHITECT_AGENT, { messages: refineMessages(b, body0, failures), temperature: 0.3, json: true, maxTokens: ARCHITECT_MAX_TOKENS });
      const d = parseDraft(res.text);
      const problem = d.problem ?? draftProblem(d.prompt, b, revision);
      if (!problem) {
        body = String(d.prompt);
        source = "llm";
        note = `refine r${opts.round}: ${d.note ?? res.model}`;
      } else note = `refine r${opts.round}: notes only (llm draft rejected: ${problem}; ${res.model}, ${res.tokensOut} tokens out)`;
    } catch (e) {
      if (e instanceof LabBudgetError) throw e;
      note = `refine r${opts.round}: notes only (llm error: ${String((e as Error)?.message ?? e).slice(0, 120)})`;
    }
  }
  const genome = assembleGenome(b, body, { version: opts.version ?? prev.version, note, at: opts.at, revision, op: "studio.refine" });
  genome.parent_ids = [];
  genome.mutation_log = [...(prev.mutation_log ?? []), ...genome.mutation_log].slice(-20);
  const check = constitutionCheck(b, genome);
  const g: Genome = await finalizeGenome(genome, opts.at ?? Date.now());
  return { genome, genome_id: g.id, source, note, check, round: opts.round };
}
