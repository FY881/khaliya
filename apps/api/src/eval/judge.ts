/**
 * Grading. Deterministic checkers always run first and are final for non-rubric items.
 * Rubric items go to a panel of ≥2 DISTINCT judge models (LabLLM.judgeModels, rotated daily). Every
 * judge call is pinned to its model (`only`), so two judges can never silently collapse onto one
 * fallback. In pairwise mode every judge sees both orders (A,B) and (B,A); a judge whose verdict flips
 * with position is counted as a draw, which cancels position bias.
 */
import { extractJson } from "../util";
import { runDeterministic } from "./checkers";
import { promptTextOf } from "./synonyms";
import { LlmRouterError } from "../llm/router";
import type { LabLLM } from "./llm";
import { judgePairMessages, judgeRubricMessages } from "./prompts";
import { normalizeText, words } from "./text";
import type { ItemSpec, RubricChecker, RubricCriterion, Verdict } from "./types";

export type JudgeItem = Pick<ItemSpec, "task" | "inputs" | "checker"> & Partial<Pick<ItemSpec, "reference">>;

export interface JudgeCall {
  model: string;
  /** "absolute" = rubric scoring of the candidate; "AB"/"BA" = pairwise vs the reference in that order. */
  order: "absolute" | "AB" | "BA";
  score: number; // 0..1 (pairwise: 1 candidate better, 0.5 tie, 0 reference better)
  flags?: string[];
  error?: string;
}

export interface JudgeResult extends Verdict {
  verdicts: JudgeCall[];
}

export interface JudgeOptions {
  /** Number of distinct judge models (min 2). */
  judges?: number;
  /**
   * "absolute" (default): each judge scores the answer against the rubric.
   * "pairwise": additionally each judge compares the answer with the item's reference twice, positions swapped;
   * the pairwise preference is blended into the score (`pairwise_weight`, default 0.3).
   */
  mode?: "absolute" | "pairwise";
  pairwise_weight?: number;
  agentId?: string;
}

const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function weightedScore(scores: Record<string, unknown>, criteria: RubricCriterion[]): number {
  const tw = criteria.reduce((s, c) => s + (c.weight ?? 1), 0) || 1;
  return criteria.reduce((s, c) => s + clamp01(scores?.[c.id]) * (c.weight ?? 1), 0) / tw;
}

/** 1 = all judges gave the same score, 0 = maximal spread. */
export function scoreAgreement(scores: number[]): number {
  if (scores.length < 2) return 0;
  return Math.round((1 - (Math.max(...scores) - Math.min(...scores))) * 1000) / 1000;
}

function inputStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 200) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => inputStrings(x, out, depth + 1));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => inputStrings(x, out, depth + 1));
  return out;
}

/**
 * Cheap, deterministic gaming signals for prose (rubric) answers, checked BEFORE any judge call so a
 * gamed answer costs no LLM budget and cannot talk a weak judge round:
 *  - echo_task:    the answer contains the whole task text
 *  - echo_inputs:  the answer contains the raw inputs JSON, or is itself bare JSON
 *  - copies_inputs: ≥3 long input passages pasted verbatim and ≥75% of them (hedging over the sources)
 *  - word_list:    a long comma/semicolon list of 1-2-word fragments (keyword stuffing dressed as prose)
 */
export function gamingSignals(item: Pick<ItemSpec, "task" | "inputs">, answer: string): string[] {
  const out: string[] = [];
  const a = normalizeText(answer);
  const task = normalizeText(item.task ?? "");
  if (task.length >= 20 && a.includes(task)) out.push("echo_task");
  const raw = JSON.stringify(item.inputs ?? {});
  const trimmed = answer.trim();
  if ((raw.length > 20 && answer.includes(raw)) || (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed))) out.push("echo_inputs");
  const long = [...new Set(inputStrings(item.inputs).map(normalizeText))].filter((s) => s.length >= 20);
  if (long.length >= 3) {
    const copied = long.filter((s) => a.includes(s)).length;
    if (copied >= 3 && copied / long.length >= 0.75) out.push("copies_inputs");
  }
  const segs = answer.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 10 && segs.filter((s) => words(s).length <= 2).length / segs.length >= 0.7) out.push("word_list");
  return out;
}

const policy = (model: string) => ({ primary: model, fallbacks: [], temperature: 0 });

/**
 * A judge panel whose slots can be re-staffed: when a pinned judge call fails at the provider (e.g. Gemini 503
 * "high demand" — seen live 2026-10-12), that slot moves to the next judge model NOT already on the panel and the
 * unit of work is retried once, so the panel stays ≥2 DISTINCT models. Budget/kill errors (LabBudgetError) are not
 * LlmRouterErrors and always propagate. With no spare model the original error propagates (job retries it).
 */
class Panel {
  constructor(
    readonly models: string[],
    private spare: string[],
  ) {}
  /**
   * Call judge seat i; when its model is down or rate-limited (LlmRouterError), move the seat to the next spare and
   * try again, up to MAX_SWAPS spares (was: one spare only — a 429 on both the seat and its first spare failed the
   * whole job chunk even though OpenRouter / Workers AI judges were free; seen live 2026-10-13). A spare already
   * seated elsewhere is skipped so the panel stays ≥2 distinct models.
   */
  async call<T>(i: number, fn: (model: string) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let swaps = 0; swaps <= Panel.MAX_SWAPS; swaps++) {
      try {
        return await fn(this.models[i]);
      } catch (e) {
        if (!(e instanceof LlmRouterError)) throw e;
        last = e;
        let alt = this.spare.shift();
        while (alt && this.models.includes(alt)) alt = this.spare.shift();
        if (!alt) throw e;
        this.models[i] = alt;
      }
    }
    throw last;
  }
  static MAX_SWAPS = 4;
}
async function panelFor(lab: LabLLM, n: number): Promise<Panel> {
  const models = await lab.judgeModelsLive(n);
  return new Panel([...models], lab.judgeOrder().filter((m) => !models.includes(m)));
}

async function rubricCall(item: JudgeItem, c: RubricChecker, answer: string, model: string, lab: LabLLM, agentId: string): Promise<JudgeCall> {
  const res = await lab.complete(agentId, { messages: judgeRubricMessages(item, c.criteria, answer), temperature: 0, json: true, maxTokens: 400 }, policy(model), { only: true });
  const j = extractJson<{ scores?: Record<string, unknown>; flags?: unknown }>(res.text);
  if (!j || typeof j.scores !== "object" || j.scores === null) return { model, order: "absolute", score: 0, error: "unparseable judge reply" };
  const flags = Array.isArray(j.flags) ? j.flags.filter((f): f is string => typeof f === "string").slice(0, 5) : [];
  // A judge that flags gaming forfeits the answer regardless of what it scored.
  const gamed = flags.some((f) => /inject|stuff|off_topic/i.test(f));
  return { model, order: "absolute", score: gamed ? 0 : weightedScore(j.scores, c.criteria), flags };
}

/** One judge, one order. Returns which of (first, second) won, as "first" | "second" | "tie". */
async function pairCall(item: JudgeItem, criteria: RubricCriterion[], first: string, second: string, model: string, lab: LabLLM, agentId: string) {
  const res = await lab.complete(agentId, { messages: judgePairMessages(item, criteria, first, second), temperature: 0, json: true, maxTokens: 300 }, policy(model), { only: true });
  const w = String(extractJson<{ winner?: unknown }>(res.text)?.winner ?? "").trim().toUpperCase();
  return w === "A" ? "first" : w === "B" ? "second" : "tie";
}

export interface PairwiseResult {
  winner: "A" | "B" | "draw";
  agreement: number; // share of judges whose (position-consistent) verdict matches the winner
  /** share of judges whose verdict survived the position swap */
  position_consistency: number;
  votes: { model: string; ab: "A" | "B" | "tie"; ba: "A" | "B" | "tie"; vote: "A" | "B" | "draw" }[];
}

/**
 * Compare two answers. Deterministic items: pass/fail decides (both or neither → draw).
 * Rubric items: each of ≥2 judges sees (A,B) then (B,A); a judge's vote counts only if it is position-consistent.
 */
export async function pairwise(item: JudgeItem, answerA: string, answerB: string, lab: LabLLM, opts: { judges?: number; agentId?: string } = {}): Promise<PairwiseResult> {
  if (item.checker.type !== "rubric") {
    const ctx = { prompt: promptTextOf(item) };
    const a = runDeterministic(item.checker, answerA, ctx).pass;
    const b = runDeterministic(item.checker, answerB, ctx).pass;
    return { winner: a === b ? "draw" : a ? "A" : "B", agreement: 1, position_consistency: 1, votes: [] };
  }
  const c = item.checker;
  // Over-long answers lose outright (cheap pre-check, no LLM call).
  const okA = !c.max_length || answerA.length <= c.max_length;
  const okB = !c.max_length || answerB.length <= c.max_length;
  if (!okA || !okB) return { winner: okA === okB ? "draw" : okA ? "A" : "B", agreement: 1, position_consistency: 1, votes: [] };

  // A gamed answer loses to an honest one without spending judge calls.
  const gA = gamingSignals(item, answerA).length > 0;
  const gB = gamingSignals(item, answerB).length > 0;
  if (gA || gB) return { winner: gA === gB ? "draw" : gA ? "B" : "A", agreement: 1, position_consistency: 1, votes: [] };

  const agentId = opts.agentId ?? "lab:judge";
  const panel = await panelFor(lab, Math.max(2, opts.judges ?? 2));
  const votes: PairwiseResult["votes"] = [];
  for (let i = 0; i < panel.models.length; i++) {
    // both orders come from the SAME model: a re-staffed slot redoes the pair
    const [r1, r2] = await panel.call(i, async (m) => [
      await pairCall(item, c.criteria, answerA, answerB, m, lab, agentId), // A first
      await pairCall(item, c.criteria, answerB, answerA, m, lab, agentId), // B first
    ]);
    const m = panel.models[i];
    const ab = r1 === "first" ? "A" : r1 === "second" ? "B" : "tie";
    const ba = r2 === "first" ? "B" : r2 === "second" ? "A" : "tie";
    const vote = ab === ba && ab !== "tie" ? ab : "draw";
    votes.push({ model: m, ab, ba, vote });
  }
  const nA = votes.filter((v) => v.vote === "A").length;
  const nB = votes.filter((v) => v.vote === "B").length;
  const winner = nA > nB ? "A" : nB > nA ? "B" : "draw";
  const agreement = votes.filter((v) => v.vote === winner).length / votes.length;
  const position_consistency = votes.filter((v) => v.ab === v.ba).length / votes.length;
  return { winner, agreement: round(agreement), position_consistency: round(position_consistency), votes };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Grade one answer. Never throws on bad judge output; LabBudgetError (budget/kill switch) propagates. */
export async function judge(item: JudgeItem, answer: string, lab: LabLLM, opts: JudgeOptions = {}): Promise<JudgeResult> {
  const pre = runDeterministic(item.checker, answer, { prompt: promptTextOf(item) });
  if (item.checker.type !== "rubric" || pre.method === "deterministic") return { ...pre, verdicts: [] };

  const c = item.checker;
  const signals = gamingSignals(item, answer);
  if (signals.length) return { pass: false, score: 0, method: "deterministic", agreement: 1, detail: `gaming: ${signals.join(", ")}`, verdicts: [] };
  const agentId = opts.agentId ?? "lab:judge";
  const panel = await panelFor(lab, Math.max(2, opts.judges ?? 2));
  const models = panel.models;
  const verdicts: JudgeCall[] = [];
  for (let i = 0; i < models.length; i++) verdicts.push(await panel.call(i, (m) => rubricCall(item, c, answer, m, lab, agentId)));

  const perJudge = new Map<string, number>();
  for (const v of verdicts) if (!v.error) perJudge.set(v.model, v.score);

  if (opts.mode === "pairwise" && item.reference) {
    const w = Math.min(1, Math.max(0, opts.pairwise_weight ?? 0.3));
    for (let i = 0; i < models.length; i++) {
      const ref = item.reference;
      const [r1, r2] = await panel.call(i, async (mm) => [
        await pairCall(item, c.criteria, answer, ref, mm, lab, agentId), // candidate first
        await pairCall(item, c.criteria, ref, answer, mm, lab, agentId), // candidate second
      ]);
      const m = models[i];
      const s1 = r1 === "first" ? 1 : r1 === "second" ? 0 : 0.5;
      const s2 = r2 === "second" ? 1 : r2 === "first" ? 0 : 0.5;
      verdicts.push({ model: m, order: "AB", score: s1 }, { model: m, order: "BA", score: s2 });
      // position-inconsistent verdicts average to 0.5 (a tie), which is exactly the de-biased reading
      const pref = (s1 + s2) / 2;
      // a candidate as good as the reference (tie) keeps its rubric score; worse lowers it, better can't exceed 1
      if (perJudge.has(m)) perJudge.set(m, (1 - w) * perJudge.get(m)! + w * Math.min(1, perJudge.get(m)! + (pref - 0.5)));
    }
  }

  const scores = [...perJudge.values()];
  const valid = scores.length;
  const threshold = c.pass_threshold ?? 0.7;
  if (valid < 2) {
    return {
      pass: false,
      score: valid ? round(scores[0]) : 0,
      method: "panel",
      agreement: 0,
      detail: `panel incomplete: ${valid}/${models.length} judges returned a usable verdict`,
      judges: verdicts.filter((v) => v.order === "absolute").map((v) => ({ model: v.model, score: round(v.score), flags: v.flags })),
      verdicts,
    };
  }
  const score = round(scores.reduce((a, b) => a + b, 0) / valid);
  const agreement = scoreAgreement(scores);
  const flags = [...new Set(verdicts.flatMap((v) => v.flags ?? []))];
  return {
    pass: score >= threshold,
    score,
    method: "panel",
    agreement,
    detail: [`${valid} judges`, `threshold ${threshold}`, flags.length ? `flags: ${flags.join(", ")}` : ""].filter(Boolean).join("; "),
    judges: [...perJudge.entries()].map(([model, s]) => ({ model, score: round(s), flags: verdicts.find((v) => v.model === model && v.order === "absolute")?.flags })),
    verdicts,
  };
}
