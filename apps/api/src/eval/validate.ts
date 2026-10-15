/**
 * Item validation pipeline. Gates run in this order and the first hard failure rejects the item:
 *
 *   1. structure       well-formed spec (checker, task, reference, difficulty, split, suite exists)
 *   2. dedupe          exact hash and near-duplicate (shingle Jaccard ≥ 0.85) within the suite;
 *                      leakage: the reference must not appear in the task (or, if long, in the inputs)
 *   3. solvable        the reference passes its own checker; for family items the family's solver
 *                      (computed from public inputs) passes too
 *   4. anti_gaming     no static attack (cheater.ts) and no family "plausible wrong answer" passes
 *   5. discriminative  strong baseline passes AND weak baseline fails (canaries exempt);
 *                      strong fails → outcome 'reserve' (too hard for now), later gates still run
 *   6. flake           reference judged twice + strong solved & judged twice: verdicts must agree
 *   7. critic          Critic review (reviewItemMessages); must approve
 *   8. quality         0..1 score from critic score, discrimination margin, gaming margin, novelty
 *
 * The outcome is persisted on the item: 'active' (= validated), 'reserve' or 'rejected', with quality
 * and the full report. Exact-duplicate rejections are not persisted (the hash already exists).
 */
import type { Role } from "../constitution";
import type { Env } from "../env";
import type { Genome } from "../genome/schema";
import { Registry } from "../registry/registry";
import { extractJson } from "../util";
import { baselines, criticBaseline } from "./baselines";
import { gamingReport } from "./cheater";
import { checkerErrors } from "./checkers";
import { FAMILY_MAP } from "./families";
import { judge, type JudgeResult } from "./judge";
import type { LabLLM } from "./llm";
import { reviewItemMessages } from "./prompts";
import { attempt, type SolverGenome } from "./solver";
import { findNearDuplicate, getItemByHash, getSuite, insertItem, itemHash, itemIdFromHash, maxSimilarity, recordResult, type ResultInput } from "./store";
import { normalizeText } from "./text";
import { SPLITS, type EvalItem, type ItemSpec, type StageResult, type ValidationReport } from "./types";

export const GATES = ["structure", "dedupe", "solvable", "anti_gaming", "discriminative", "flake", "critic", "quality"] as const;
export type Gate = (typeof GATES)[number];

export interface GateResult {
  gate: Gate;
  pass: boolean;
  reason?: string;
  data?: unknown;
}

export interface ValidateOptions {
  author?: string;
  author_lineage?: string | null;
  /** Persist the item + its outcome (default true). */
  persist?: boolean;
  strong?: SolverGenome;
  weak?: SolverGenome;
  critic?: Genome;
  judges?: number;
  /** Receives the baseline attempts (strong / weak / flake re-runs) even when nothing is persisted. */
  collect?: ResultInput[];
}

export interface ValidationOutcome {
  status: "active" | "reserve" | "rejected";
  /** true iff status === 'active' */
  validated: boolean;
  quality: number | null;
  reason?: string;
  gates: GateResult[];
  report: ValidationReport;
  item_id: string;
  item: EvalItem | null;
  /** true when the item was not persisted because the exact same item already exists. */
  duplicate_of?: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const MAX_TASK = 4000;
const MAX_REFERENCE = 4000;

/** Champion genome of a role, if the registry has one. */
export async function championGenome(env: Env, role: Role): Promise<Genome | null> {
  const row = await env.DB.prepare("SELECT genome_id FROM agents WHERE role = ?1 AND status = 'champion' ORDER BY updated_at DESC LIMIT 1")
    .bind(role)
    .first<{ genome_id: string }>();
  return row ? new Registry(env).getGenome(row.genome_id) : null;
}

// ---------------- gate 1: structure ----------------
export function structureProblems(spec: ItemSpec): string[] {
  const e: string[] = [];
  if (!spec || typeof spec !== "object") return ["item must be an object"];
  if (typeof spec.suite_id !== "string" || !spec.suite_id) e.push("suite_id required");
  if (typeof spec.task !== "string" || spec.task.trim().length < 10) e.push("task: at least 10 characters");
  else if (spec.task.length > MAX_TASK) e.push(`task: at most ${MAX_TASK} characters`);
  if (!spec.inputs || typeof spec.inputs !== "object" || Array.isArray(spec.inputs)) e.push("inputs: object");
  else if (JSON.stringify(spec.inputs).length > 16000) e.push("inputs: too large");
  if (typeof spec.reference !== "string" || !spec.reference.trim()) e.push("reference: non-empty string");
  else if (spec.reference.length > MAX_REFERENCE) e.push(`reference: at most ${MAX_REFERENCE} characters`);
  if (!Number.isInteger(spec.difficulty) || spec.difficulty < 1 || spec.difficulty > 10) e.push("difficulty: integer 1-10");
  if (!SPLITS.includes(spec.split)) e.push(`split: one of ${SPLITS.join(", ")}`);
  if (!Array.isArray(spec.tags) || !spec.tags.every((t) => typeof t === "string")) e.push("tags: string[]");
  e.push(...checkerErrors(spec.checker));
  return e;
}

// ---------------- gate 2 (part): leakage ----------------
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function containsPhrase(hay: string, needle: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}($|[^\\p{L}\\p{N}])`, "u").test(hay);
}

/**
 * The reference must not be readable from what the solver sees. Short answers (a year, a name, an id)
 * legitimately occur in extraction inputs, so against the inputs only references ≥ 24 normalized chars
 * count as leaked (a pasted solution); against the task any reference does (word-bounded; parenthesised format examples are ignored).
 */
export function leakage(spec: Pick<ItemSpec, "task" | "inputs" | "reference">): string | null {
  const ref = normalizeText(spec.reference ?? "");
  if (!ref) return null;
  // format examples such as "(for example S1)" are not leakage
  const task = String(spec.task ?? "").replace(/\((?:for example|for instance|e\.g\.?|eg|example:)[^)]*\)/gi, " ");
  if (containsPhrase(normalizeText(task), ref)) return "reference appears in the task";
  if (ref.length >= 24) {
    const inp = normalizeText(JSON.stringify(spec.inputs ?? {}));
    if (inp.includes(ref)) return "reference appears in the inputs";
  }
  return null;
}

// ---------------- the pipeline ----------------
export async function validateItem(env: Env, lab: LabLLM, spec: ItemSpec, opts: ValidateOptions = {}): Promise<ValidationOutcome> {
  const gates: GateResult[] = [];
  const pending: ResultInput[] = [];
  const callsAtStart = lab.calls;
  const persist = opts.persist !== false;
  const judgeOpts = { judges: opts.judges ?? 2, agentId: "lab:validate" };
  const pass = (gate: Gate, reason?: string, data?: unknown) => gates.push({ gate, pass: true, reason, data });
  const fail = (gate: Gate, reason: string, data?: unknown) => gates.push({ gate, pass: false, reason, data });

  let hash = "";
  let itemId = "";
  let reserveReason: string | undefined;
  let duplicateOf: string | undefined;
  let role: Role = "evaluator";

  const finish = async (status: ValidationOutcome["status"], reason?: string, quality: number | null = null): Promise<ValidationOutcome> => {
    const stages: Record<string, StageResult> = {};
    for (const g of gates) stages[g.gate] = { ok: g.pass, detail: g.reason, data: g.data };
    const report: ValidationReport = { at: Date.now(), outcome: status, reason, stages, quality: quality ?? undefined, llm_calls: lab.calls - callsAtStart };
    let item: EvalItem | null = null;
    if (opts.collect) opts.collect.push(...pending);
    if (persist && itemId && !duplicateOf) {
      item = await insertItem(env, spec, {
        role,
        author: opts.author ?? "owner",
        author_lineage: opts.author_lineage ?? null,
        status,
        quality,
        validation: report,
        status_reason: reason ?? null,
      });
      if (item) for (const r of pending) await recordResult(env, { ...r, item_id: item.id });
    }
    return { status, validated: status === "active", quality, reason, gates, report, item_id: itemId, item, duplicate_of: duplicateOf };
  };

  // 1. structure
  const problems = structureProblems(spec);
  const suite = typeof spec?.suite_id === "string" ? await getSuite(env, spec.suite_id) : null;
  if (!suite && !problems.length) problems.push(`unknown suite '${spec.suite_id}'`);
  if (problems.length) {
    fail("structure", problems.join("; "));
    return finish("rejected", `structure: ${problems[0]}`);
  }
  role = suite!.role;
  hash = await itemHash(spec.suite_id, spec.task, spec.inputs);
  itemId = itemIdFromHash(hash);
  pass("structure");

  // 2. dedupe + leakage
  const existing = await getItemByHash(env, hash);
  if (existing) {
    duplicateOf = existing.id;
    fail("dedupe", `exact duplicate of ${existing.id}`);
    return finish("rejected", "dedupe: exact duplicate");
  }
  const near = await findNearDuplicate(env, spec.suite_id, spec);
  if (near) {
    fail("dedupe", `near-duplicate of ${near.id} (similarity ${near.similarity})`, near);
    return finish("rejected", "dedupe: near-duplicate");
  }
  const leak = leakage(spec);
  if (leak) {
    fail("dedupe", `leakage: ${leak}`);
    return finish("rejected", `leakage: ${leak}`);
  }
  const novelty = round(1 - (await maxSimilarity(env, spec.suite_id, spec)));
  pass("dedupe", undefined, { novelty });

  // 3. solvable
  const refVerdict = await judge(spec, spec.reference, lab, judgeOpts);
  if (!refVerdict.pass) {
    fail("solvable", `reference fails its own checker (${refVerdict.detail ?? `score ${refVerdict.score}`})`);
    return finish("rejected", "solvable: reference fails checker");
  }
  const fam = FAMILY_MAP[String((spec.inputs as { kind?: unknown })?.kind ?? "")];
  if (fam) {
    let famAnswer = "";
    try {
      famAnswer = fam.solve(spec.inputs as Record<string, any>);
    } catch (e) {
      fail("solvable", `family '${fam.kind}' cannot solve these inputs: ${(e as Error).message}`);
      return finish("rejected", "solvable: family solver failed");
    }
    const fv = await judge(spec, famAnswer, lab, judgeOpts);
    if (!fv.pass) {
      fail("solvable", `family '${fam.kind}' solution fails the checker (inputs and checker disagree)`);
      return finish("rejected", "solvable: family solution fails checker");
    }
  }
  pass("solvable", undefined, { reference_score: refVerdict.score });

  // 4. anti-gaming
  const gr = await gamingReport({ ...spec }, lab);
  let wrongPassed = false;
  if (fam && fam.kind !== "safety") {
    try {
      wrongPassed = (await judge(spec, fam.wrong(spec.inputs as Record<string, any>), lab, judgeOpts)).pass;
    } catch {
      wrongPassed = false;
    }
  }
  if (!gr.resists || wrongPassed) {
    const what = [...gr.passed.map((p) => p.attack), ...(wrongPassed ? ["family_wrong_answer"] : [])];
    fail("anti_gaming", `gameable: ${what.slice(0, 5).join(", ")}`, { tried: gr.tried, passed: gr.passed.slice(0, 5) });
    return finish("rejected", "anti_gaming: gameable");
  }
  const gamingMargin = 1; // no attack passed (scores of passing attacks are 0 by construction here)
  pass("anti_gaming", undefined, { tried: gr.tried });

  // 5. discriminative
  const { strong: sb, weak: wb } = await baselines(role);
  const strong = opts.strong ?? sb;
  const weak = opts.weak ?? wb;
  let discrimination = 0.5;
  let strongFirst: JudgeResult | null = null;
  if (spec.split === "canary") {
    pass("discriminative", "exempt (canary)");
  } else {
    const s = await attempt(lab, strong, spec, judgeOpts);
    const w = await attempt(lab, weak, spec, judgeOpts, { pinned: true }); // never let "weak" fall back to a strong model
    strongFirst = s.verdict;
    pending.push(
      { item_id: "", genome_id: strong.id, context: "validation", ref: "strong", pass: s.verdict.pass, score: s.verdict.score, answer: s.answer, judge: slim(s.verdict), tokens: s.tokens },
      { item_id: "", genome_id: weak.id, context: "validation", ref: "weak", pass: w.verdict.pass, score: w.verdict.score, answer: w.answer, judge: slim(w.verdict), tokens: w.tokens },
    );
    const data = { strong: { pass: s.verdict.pass, score: s.verdict.score }, weak: { pass: w.verdict.pass, score: w.verdict.score } };
    if (!s.verdict.pass) {
      reserveReason = "too hard: strong baseline fails";
      pass("discriminative", `reserve: ${reserveReason}`, data);
    } else if (w.verdict.pass) {
      fail("discriminative", "not discriminative: weak baseline also passes", data);
      return finish("rejected", "discriminative: weak baseline passes");
    } else {
      discrimination = round(Math.max(0, s.verdict.score - w.verdict.score));
      pass("discriminative", undefined, data);
    }
  }

  // 6. flake: same answer judged twice must agree; the strong baseline re-solved twice must agree too.
  const r1 = await judge(spec, spec.reference, lab, judgeOpts);
  const r2 = await judge(spec, spec.reference, lab, judgeOpts);
  const flakes: string[] = [];
  if (r1.pass !== r2.pass || Math.abs(r1.score - r2.score) > 0.1) flakes.push("reference verdict changed between two judgings");
  if (spec.split !== "canary") {
    const a1 = await attempt(lab, strong, spec, judgeOpts);
    const a2 = await attempt(lab, strong, spec, judgeOpts);
    const verdicts = [strongFirst?.pass, a1.verdict.pass, a2.verdict.pass].filter((x): x is boolean => typeof x === "boolean");
    if (new Set(verdicts).size > 1) flakes.push(`strong baseline verdict unstable across reruns (${verdicts.map((v) => (v ? "pass" : "fail")).join(", ")})`);
    pending.push(
      { item_id: "", genome_id: strong.id, context: "recheck", ref: "flake:1", pass: a1.verdict.pass, score: a1.verdict.score, answer: a1.answer, judge: slim(a1.verdict), tokens: a1.tokens },
      { item_id: "", genome_id: strong.id, context: "recheck", ref: "flake:2", pass: a2.verdict.pass, score: a2.verdict.score, answer: a2.answer, judge: slim(a2.verdict), tokens: a2.tokens },
    );
  }
  if (flakes.length) {
    fail("flake", flakes.join("; "));
    return finish("rejected", "flake: inconsistent verdicts");
  }
  pass("flake");

  // 7. critic review (the critic sees the reference; it is Governor-side, never a solver)
  const critic = opts.critic ?? (await championGenome(env, "critic")) ?? (await criticBaseline());
  const res = await lab.complete("lab:critic", { messages: reviewItemMessages(critic, spec, { safety_canary: fam?.kind === "safety", reference_verified: !!fam && fam.kind !== "safety" }), temperature: 0, json: true, maxTokens: 600 }, critic.model_policy);
  const review = extractJson<{ approve?: unknown; score?: unknown; issues?: unknown; blocking_issues?: unknown; suggestions?: unknown }>(res.text);
  if (!review || typeof review.approve !== "boolean") {
    fail("critic", "critic reply unparseable");
    return finish("rejected", "critic: unparseable review");
  }
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string" && !!y.trim()).slice(0, 5) : []);
  const blocking = strs(review.blocking_issues);
  const issues = [...blocking, ...strs(review.issues), ...strs(review.suggestions)].slice(0, 5);
  const criticScore = typeof review.score === "number" && Number.isFinite(review.score) ? Math.min(1, Math.max(0, review.score)) : review.approve ? 0.7 : 0;
  // A rejection always stands (even with no stated reason): the critic is the last human-like check.
  if (!review.approve) {
    fail("critic", `critic rejected: ${issues.join("; ") || "no reason given"}`, { score: criticScore, blocking, issues });
    return finish("rejected", "critic: rejected");
  }
  // approve=true but blocking issues listed is self-contradictory → treat as a rejection (conservative).
  if (blocking.length) {
    fail("critic", `critic approved but listed blocking issues: ${blocking.join("; ")}`, { score: criticScore, blocking, issues });
    return finish("rejected", "critic: blocking issues");
  }
  pass("critic", issues.length ? issues.join("; ") : undefined, { score: criticScore, issues });

  // 8. quality
  const quality = round(0.4 * criticScore + 0.3 * discrimination + 0.15 * gamingMargin + 0.15 * novelty);
  pass("quality", undefined, { quality, critic: criticScore, discrimination, novelty });
  return reserveReason ? finish("reserve", reserveReason, quality) : finish("active", undefined, quality);
}

function slim(v: JudgeResult) {
  return { method: v.method, agreement: v.agreement, detail: v.detail, judges: v.judges };
}
