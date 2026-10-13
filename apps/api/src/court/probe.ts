/**
 * Judge Court probes. One "unit" = one judge model seeing one answer pair in BOTH orders (the same pairwise prompt
 * contract as eval/judge.ts, pinned to that model). Pairs are stored content-mapped: X = the answer under test
 * (good / padded / own-family / good-in-this-language), Y = its counterpart; `ab` is the verdict with X shown
 * first, `ba` with Y shown first, each mapped back to X | Y | tie.
 *
 *   position   good vs good2 (equal quality): order-stable verdicts (incl. tie/tie) count as consistent
 *   verbosity  good+padding vs good: outcome 1 = padding won (bias), 0.5 = draw, 0 = concise won
 *   gold       good vs weak: outcome 1 = right winner
 *   lang       gold pair in EN *and* AR (two rows, same item): verdicts must match across languages
 *   self_pref  the judge's OWN answer vs an answer from a model of another family (both generated now, kept only
 *              when the rubric coverage of the two is equal): outcome 1 = own answer won
 */
import type { LabLLM } from "../eval/llm";
import { judgePairMessages } from "../eval/prompts";
import type { RubricCriterion } from "../eval/types";
import { LlmRouterError } from "../llm/router";
import { extractJson } from "../util";
import { coverage, PADDING, PROBE_MAP, type Lang, type ProbeItem } from "./bank";

export type ProbeKind = "position" | "verbosity" | "gold" | "lang" | "self_pref";
export const PROBE_KINDS: ProbeKind[] = ["position", "verbosity", "gold", "lang", "self_pref"];
export type Side = "X" | "Y" | "tie";

/** Model family for self-preference: the vendor lineage of the weights, not the API that serves them. */
export function judgeFamily(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("mock:")) return m; // each deterministic mock judge is its own family
  if (m.startsWith("gemini:") || m.includes("gemma")) return "gemini";
  if (m.includes("llama")) return "llama";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("qwen") || m.includes("qwq")) return "qwen";
  if (m.includes("mistral")) return "mistral";
  if (m.includes("gpt-oss") || m.includes("openai")) return "openai";
  return m.split(":")[0];
}

export interface ProbeUnit {
  judge: string;
  kind: ProbeKind;
  item: string;
  lang: Lang; // for 'lang' units: the first language (both are run)
}

export interface ProbeRow {
  judge_model: string;
  judge_family: string;
  probe: ProbeKind;
  lang: Lang;
  item_key: string;
  ab: Side;
  ba: Side;
  verdict: Side | "draw";
  consistent: boolean;
  outcome: number | null;
  detail?: Record<string, unknown>;
  /** answers shown (for the spot-check queue): A = X, B = Y */
  answers?: { task: string; criteria: RubricCriterion[]; x: string; y: string };
}

const policy = (model: string) => ({ primary: model, fallbacks: [], temperature: 0 });

async function rawWinner(lab: LabLLM, model: string, task: string, criteria: RubricCriterion[], first: string, second: string): Promise<"first" | "second" | "tie"> {
  const res = await lab.complete("lab:court", { messages: judgePairMessages({ task, inputs: {} }, criteria, first, second), temperature: 0, json: true, maxTokens: 200 }, policy(model), { only: true });
  const w = String(extractJson<{ winner?: unknown }>(res.text)?.winner ?? "").trim().toUpperCase();
  return w === "A" ? "first" : w === "B" ? "second" : "tie";
}

/** One judge, both orders, content-mapped. */
export async function judgeBothOrders(lab: LabLLM, model: string, task: string, criteria: RubricCriterion[], x: string, y: string): Promise<{ ab: Side; ba: Side; verdict: Side | "draw"; consistent: boolean }> {
  const r1 = await rawWinner(lab, model, task, criteria, x, y); // X first
  const r2 = await rawWinner(lab, model, task, criteria, y, x); // Y first
  const ab: Side = r1 === "first" ? "X" : r1 === "second" ? "Y" : "tie";
  const ba: Side = r2 === "first" ? "Y" : r2 === "second" ? "X" : "tie";
  const consistent = ab === ba;
  return { ab, ba, consistent, verdict: consistent && ab !== "tie" ? ab : "draw" };
}

const sideScore = (v: Side | "draw") => (v === "X" ? 1 : v === "Y" ? 0 : 0.5);

export function answerMessages(task: string) {
  return [
    { role: "system" as const, content: "Answer the question helpfully and concisely in the same language as the question. Reply with JSON only." },
    { role: "user" as const, content: ["MODE: court_answer", `TASK: ${task}`, 'Return {"answer": "<2-3 sentences>"}.'].join("\n") },
  ];
}

/** Parse a generated answer from any reasonable reply shape. */
export function parseGenerated(text: string): string {
  const j = extractJson<{ answer?: unknown; final?: unknown }>(text);
  const a = typeof j?.answer === "string" ? j.answer : typeof j?.final === "string" ? j.final : text;
  return a.trim().slice(0, 1200);
}

async function generate(lab: LabLLM, model: string, task: string): Promise<string> {
  const res = await lab.complete("lab:court", { messages: answerMessages(task), temperature: 0, json: true, maxTokens: 300 }, policy(model), { only: true });
  return parseGenerated(res.text);
}

/**
 * Run one unit. Returns the rows to store (2 for 'lang', otherwise 1). A provider failure on a pinned model returns
 * `{ error }` (the unit is skipped, the job goes on); LabBudgetError propagates so the job stops cleanly.
 * `others` = the other judge models available (for self_pref's foreign-family answer).
 */
export async function runUnit(lab: LabLLM, u: ProbeUnit, others: string[]): Promise<{ rows: ProbeRow[]; error?: string }> {
  const item: ProbeItem | undefined = PROBE_MAP[u.item];
  if (!item) return { rows: [], error: `unknown probe item ${u.item}` };
  const fam = judgeFamily(u.judge);
  const base = { judge_model: u.judge, judge_family: fam, item_key: u.kind === "self_pref" ? `self_pref:${u.item}:${u.judge}` : `${u.kind}:${u.item}` };
  try {
    if (u.kind === "lang") {
      const rows: ProbeRow[] = [];
      for (const lang of [u.lang, u.lang === "en" ? "ar" : "en"] as Lang[]) {
        const r = await judgeBothOrders(lab, u.judge, item.task[lang], item.criteria[lang], item.good[lang], item.weak[lang]);
        rows.push({ ...base, probe: "lang", lang, ...r, outcome: sideScore(r.verdict), answers: { task: item.task[lang], criteria: item.criteria[lang], x: item.good[lang], y: item.weak[lang] } });
      }
      return { rows };
    }
    const L = u.lang;
    const task = item.task[L];
    const crit = item.criteria[L];
    let x: string;
    let y: string;
    let detail: Record<string, unknown> | undefined;
    if (u.kind === "position") [x, y] = [item.good[L], item.good2[L]];
    else if (u.kind === "verbosity") [x, y] = [item.good[L] + PADDING[L], item.good[L]];
    else if (u.kind === "gold") [x, y] = [item.good[L], item.weak[L]];
    else {
      const foreign = others.find((m) => m !== u.judge && judgeFamily(m) !== fam);
      if (!foreign) return { rows: [], error: "self_pref needs a judge model of another family" };
      x = await generate(lab, u.judge, task);
      y = await generate(lab, foreign, task);
      const cx = coverage(x, crit);
      const cy = coverage(y, crit);
      detail = { foreign, coverage_own: Math.round(cx * 100) / 100, coverage_foreign: Math.round(cy * 100) / 100 };
      if (!x || !y || Math.abs(cx - cy) > 0.34) return { rows: [{ ...base, probe: "self_pref", lang: L, ab: "tie", ba: "tie", verdict: "draw", consistent: true, outcome: null, detail: { ...detail, skipped: "unequal quality" } }] };
    }
    const r = await judgeBothOrders(lab, u.judge, task, crit, x, y);
    return { rows: [{ ...base, probe: u.kind, lang: L, ...r, outcome: sideScore(r.verdict), detail, answers: { task, criteria: crit, x, y } }] };
  } catch (e) {
    if (e instanceof LlmRouterError) return { rows: [], error: `${u.judge}: ${e.message.slice(0, 200)}` };
    throw e;
  }
}

/**
 * Plan the units for one probe job: for every judge, `perJudge` units cycling through probe kinds and languages,
 * with the bank item rotated by `seed` so successive jobs cover the whole bank.
 */
export function planUnits(judges: string[], kinds: ProbeKind[], seed: number, perJudge = 6): ProbeUnit[] {
  const items = Object.keys(PROBE_MAP);
  const out: ProbeUnit[] = [];
  const canSelf = new Set(judges.map(judgeFamily)).size >= 2;
  const ks = kinds.filter((k) => k !== "self_pref" || canSelf);
  if (!ks.length) return out;
  for (let j = 0; j < judges.length; j++) {
    for (let i = 0; i < perJudge; i++) {
      const kind = ks[i % ks.length];
      const round = Math.floor(i / ks.length);
      const lang: Lang = (round + j + seed) % 2 === 0 ? "en" : "ar";
      const item = items[(seed + i * 7 + j * 3) % items.length];
      out.push({ judge: judges[j], kind, item, lang });
    }
  }
  return out;
}
