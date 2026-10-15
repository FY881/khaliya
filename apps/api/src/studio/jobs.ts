/**
 * "studio.design" job: brief(s) → designed, evaluated and (maybe) promoted service agents.
 *
 * One step = one small unit, so a chunk can die anywhere and resume from the saved cursor:
 *   architect  1 step   (≤ 1 lab call live, 0 in mock): create the design row, draft the genome, constitutionCheck
 *   suite      1 step per task (0 calls for code-checked tasks, ≤ ~10 judge calls for a rubric task's gaming check)
 *   eval       1 step per (item × arm) — 3 arms, each ≤ 1 solve + 2 judge calls
 *   decide     1 step: promotion rule → promote (putGenome + service_versions) or reject
 * then the next brief. The cursor holds ids, indices and small score counters only; genomes live in the design's
 * report, answers in eval_results.
 */
import { audit } from "../audit";
import type { Env } from "../env";
import type { JobHandler } from "../jobs/handlers";
import type { GenomeInput } from "../genome/schema";
import type { SolverGenome } from "../eval/solver";
import { architect, lineageOf, refine, STUDIO_ACTOR } from "./architect";
import { failureClass, MAX_REFINE_ROUNDS, type FailureClass, type RefineFailure } from "./craft";
import { getItem } from "../eval/store";
import { suiteIdOf } from "./briefs";
import { addOutcome, admitTask, ARMS, armGenome, decidePromotion, designItemAnswers, emptyScore, ensureStudioSuite, evalUnit, promoteDesign, type Admission, type Arm } from "./run";
import { createDesign, getDesign, listBriefRows, listDesigns, loadBrief, updateDesign } from "./store";
import type { ArmScore, DesignStatus, TaskKind } from "./types";

export const STUDIO_DESIGN_KIND = "studio.design";
export const STUDIO_CALLS_PER_BRIEF = 90;
export const MAX_STUDIO_CALLS = 1500;
/** Ceiling for re-evaluating one promoted design against its (updated) suite: no architect, no refinement. */
export const STUDIO_REEVAL_CALLS_PER_BRIEF = 60;

export class StudioJobError extends Error {
  constructor(
    public code: "not_found" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

export interface DesignCursor {
  brief_id: string;
  design_id: string | null;
  genome_id: string | null;
  phase: "architect" | "suite" | "eval" | "decide" | "refine";
  ti: number;
  items: { key: string; kind: TaskKind; item_id: string }[];
  rejected_items: { key: string; reason: string }[];
  ui: number;
  scores: Record<Arm, ArmScore>;
  outcomes: { key: string; arm: Arm; pass: boolean; score: number; round?: number; cls?: FailureClass }[];
  /** Refinement round: 0 = first design (all arms); ≥1 = candidate-only re-evaluation of a revised genome. */
  round?: number;
  /** Lab calls of the job when this brief started (per-brief budget for refinement). */
  calls_at_start?: number;
  /** Decisions of earlier rounds (kept for the report). */
  history?: { round: number; genome_id: string | null; candidate: { cap_rate: number; safety_rate: number }; reasons: string[] }[];
}

export interface StudioResult {
  brief_id: string;
  design_id: string | null;
  status: DesignStatus;
  genome_id?: string | null;
  service_version?: number;
  reasons: string[];
  candidate?: { cap_rate: number; safety_rate: number };
  strong?: { cap_rate: number; safety_rate: number };
  weak?: { cap_rate: number; safety_rate: number };
  /** Refinement rounds used (0 = the first design decided). */
  rounds?: number;
  /** reeval mode: the promoted design re-evaluated, and whether it still meets the gate. */
  reeval?: { of_design: string; verdict: "kept" | "flagged" };
}

export interface StudioJobState {
  brief_ids: string[];
  task_counts: number[];
  bi: number;
  cur: DesignCursor | null;
  results: StudioResult[];
  llm_calls: number;
  /** Units added by refinement rounds (progress total grows when a round starts). */
  extra_units?: number;
  /**
   * "reeval": re-run the brief's CURRENT suite on its latest promoted genome (no architect, no refinement, no new
   * genome or service version). If the promoted genome no longer meets the promotion rule it is FLAGGED: the new
   * design row is 'rejected' with report.reeval.flagged, and a studio.flag audit event names it. Never silently kept.
   */
  mode?: "design" | "reeval";
}

const unitsOf = (tasks: number) => 1 + tasks + tasks * ARMS.length + 1;

function newCursor(briefId: string, callsAtStart = 0): DesignCursor {
  return { round: 0, calls_at_start: callsAtStart, history: [], brief_id: briefId, design_id: null, genome_id: null, phase: "architect", ti: 0, items: [], rejected_items: [], ui: 0, scores: { candidate: emptyScore(), strong: emptyScore(), weak: emptyScore() }, outcomes: [] };
}

/** Build the initial cursor for some briefs (default: every brief, seeds first). */
export async function studioDesignInit(
  env: Env,
  briefIds?: string[],
  opts: { mode?: "design" | "reeval" } = {},
): Promise<{ state: StudioJobState; total: number; max_calls: number; params: { brief_ids: string[]; mode?: "reeval" } }> {
  const rows = await listBriefRows(env);
  const ids = briefIds?.length ? [...new Set(briefIds)] : rows.map((r) => r.id);
  const counts: number[] = [];
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r) throw new StudioJobError("not_found", `brief '${id}' not found`);
    counts.push(r.spec.tasks.length);
  }
  if (!ids.length) throw new StudioJobError("bad_request", "no briefs to design");
  const reeval = opts.mode === "reeval";
  const state: StudioJobState = { brief_ids: ids, task_counts: counts, bi: 0, cur: null, results: [], llm_calls: 0, ...(reeval ? { mode: "reeval" as const } : {}) };
  const perBrief = reeval ? STUDIO_REEVAL_CALLS_PER_BRIEF : STUDIO_CALLS_PER_BRIEF;
  return { state, total: totalOf(state), max_calls: Math.min(MAX_STUDIO_CALLS, perBrief * ids.length), params: { brief_ids: ids, ...(reeval ? { mode: "reeval" as const } : {}) } };
}

function totalOf(s: StudioJobState): number {
  return s.task_counts.reduce((a, n) => a + unitsOf(n), 0) + (s.extra_units ?? 0);
}

const armsOf = (round: number | undefined): readonly Arm[] => (round ? (["candidate"] as const) : ARMS);

/** Estimated lab calls of one refinement round: 1 architect call + candidate solves + ~3 judge calls per rubric item. */
export function refineCost(items: { kind: TaskKind }[], rubricItems: number): number {
  return 1 + items.length + 3 * rubricItems;
}

function doneOf(s: StudioJobState): number {
  let d = s.task_counts.slice(0, s.bi).reduce((a, n) => a + unitsOf(n), 0);
  const c = s.cur;
  if (c && s.bi < s.task_counts.length) {
    const n = s.task_counts[s.bi];
    if (c.phase !== "architect") d += 1;
    if (c.phase === "suite") d += c.ti;
    if (c.phase === "eval" || c.phase === "decide" || c.phase === "refine") d += n + (c.round ? c.items.length * ARMS.length + (c.round - 1) * (1 + c.items.length) + 1 + c.ui : c.ui);
  }
  return d;
}

async function finishBrief(s: StudioJobState, r: StudioResult): Promise<void> {
  s.results.push(r);
  s.bi++;
  s.cur = null;
}

/** Candidate genome id → refinement round, from the cursor (history + current round). */
function candidateRounds(c: DesignCursor): Record<string, number> {
  const m: Record<string, number> = {};
  for (const h of c.history ?? []) if (h.genome_id) m[h.genome_id] = h.round;
  if (c.genome_id) m[c.genome_id] = c.round ?? 0;
  return m;
}

async function itemAnswersOf(env: Env, c: DesignCursor) {
  return c.design_id ? designItemAnswers(env, c.design_id, c.items, candidateRounds(c)) : [];
}

async function designReport(env: Env, id: string): Promise<Record<string, any>> {
  return ((await getDesign(env, id))?.report as Record<string, any>) ?? {};
}

export const studioDesignJob: JobHandler<StudioJobState> = {
  kind: STUDIO_DESIGN_KIND,
  async step(env, lab, job, s) {
    const before = lab.calls;
    try {
      if (s.bi >= s.brief_ids.length) return { message: "done" };
      if (!s.cur) s.cur = newCursor(s.brief_ids[s.bi], s.llm_calls);
      const c = s.cur;
      const brief = await loadBrief(env, c.brief_id);
      if (!brief) {
        await finishBrief(s, { brief_id: c.brief_id, design_id: c.design_id, status: "failed", reasons: ["brief not found"] });
        return { message: `${c.brief_id}: brief not found` };
      }

      if (c.phase === "architect" && s.mode === "reeval") {
        const prev = (await listDesigns(env, { brief_id: brief.id, status: "promoted", limit: 20 })).find((x) => !(x.report as any)?.reeval && (x.report as any)?.genome);
        if (!prev) {
          await finishBrief(s, { brief_id: brief.id, design_id: null, status: "failed", reasons: ["reeval: no promoted design to re-evaluate"] });
          return { message: `${brief.id}: no promoted design to re-evaluate` };
        }
        const d = c.design_id ? (await getDesign(env, c.design_id))! : await createDesign(env, { brief_id: brief.id, lineage_id: lineageOf(brief.id), job_id: job.id });
        c.design_id = d.id;
        c.genome_id = prev.genome_id;
        const pr = prev.report as Record<string, any>;
        const report = { kind: "reeval", reeval: { of_design: prev.id, of_version: prev.version, previous_decision: pr.decision ?? null }, genome: pr.genome, architect: { source: "reeval", note: `re-evaluation of promoted design ${prev.id}` } };
        await updateDesign(env, d.id, { genome_id: prev.genome_id, suite_id: suiteIdOf(brief.id), report });
        c.phase = "suite";
        return { message: `${brief.id}: re-evaluating promoted design ${prev.id} (v${prev.version})` };
      }

      if (c.phase === "architect") {
        const d = c.design_id ? (await getDesign(env, c.design_id))! : await createDesign(env, { brief_id: brief.id, lineage_id: lineageOf(brief.id), job_id: job.id });
        c.design_id = d.id;
        const a = await architect(brief, lab, { version: d.version });
        const report = { genome: a.genome, architect: { source: a.source, note: a.note, check: a.check } };
        if (!a.check.ok) {
          await updateDesign(env, d.id, { status: "failed", genome_id: a.genome_id, report: { ...report, decision: { promote: false, reasons: a.check.errors } } });
          await finishBrief(s, { brief_id: brief.id, design_id: d.id, status: "failed", genome_id: a.genome_id, reasons: a.check.errors.map((e) => `constitution: ${e}`) });
          return { message: `${brief.id}: constitution check failed (${a.check.errors.length})` };
        }
        await updateDesign(env, d.id, { genome_id: a.genome_id, suite_id: suiteIdOf(brief.id), report });
        c.genome_id = a.genome_id;
        c.phase = "suite";
        return { message: `${brief.id}: genome drafted (${a.source}), constitution ok` };
      }

      if (c.phase === "suite") {
        if (c.ti === 0) await ensureStudioSuite(env, brief);
        const t = brief.tasks[c.ti];
        let msg = `${brief.id}: no task`;
        if (t) {
          const adm: Admission = await admitTask(env, lab, brief, t);
          if (adm.status === "active" && adm.item_id) c.items.push({ key: adm.key, kind: adm.kind, item_id: adm.item_id });
          else c.rejected_items.push({ key: adm.key, reason: adm.reason ?? "not stored" });
          msg = `${brief.id}/${t.key}: ${adm.status}${adm.reason ? ` (${adm.reason})` : ""}`;
        }
        c.ti++;
        if (c.ti >= brief.tasks.length) {
          const report = await designReport(env, c.design_id!);
          await updateDesign(env, c.design_id!, { status: "evaluating", report: { ...report, items: c.items, rejected_items: c.rejected_items } });
          c.phase = c.items.length ? "eval" : "decide";
        }
        return { message: msg };
      }

      if (c.phase === "eval") {
        const arms = armsOf(c.round);
        const it = c.items[Math.floor(c.ui / arms.length)];
        const arm = arms[c.ui % arms.length];
        let msg = `${brief.id}: skipped`;
        if (it) {
          const report = arm === "candidate" ? await designReport(env, c.design_id!) : {};
          const cand = report.genome ? ({ ...(report.genome as GenomeInput), id: c.genome_id! } as SolverGenome) : null;
          const g = await armGenome(arm, brief, cand);
          const r = await evalUnit(env, lab, arm, g, it.item_id, c.design_id!);
          if (r) {
            addOutcome(c.scores[arm], it.kind, r.pass, r.tokens);
            const cls = r.pass || arm !== "candidate" ? undefined : failureClass(it.kind, { type: r.checker_type ?? "contains" }, r.detail);
            c.outcomes.push({ key: it.key, arm, pass: r.pass, score: r.score, round: c.round ?? 0, ...(cls ? { cls } : {}) });
            msg = `${brief.id}/${it.key} ${arm}${c.round ? ` r${c.round}` : ""}: ${r.pass ? "pass" : "fail"}`;
          }
        }
        c.ui++;
        if (c.ui >= c.items.length * arms.length) c.phase = "decide";
        return { message: msg };
      }

      if (c.phase === "refine") {
        const round = (c.round ?? 0) + 1;
        const report = await designReport(env, c.design_id!);
        const failed = c.outcomes.filter((o) => o.arm === "candidate" && !o.pass && (o.round ?? 0) === (c.round ?? 0));
        const failures: RefineFailure[] = [];
        for (const o of failed) {
          const it = c.items.find((x) => x.key === o.key);
          const item = it ? await getItem(env, it.item_id) : null;
          const ans = await env.DB.prepare("SELECT answer FROM eval_results WHERE ref = ?1 AND item_id = ?2 AND genome_id = ?3 ORDER BY at DESC, id DESC LIMIT 1")
            .bind(c.design_id, it?.item_id ?? "", c.genome_id ?? "")
            .first<{ answer: string | null }>()
            .catch(() => null);
          if (item) failures.push({ key: o.key, kind: it!.kind, task: item.task, answer: String(ans?.answer ?? ""), cls: o.cls ?? "other" });
        }
        const r = await refine(brief, report.genome as GenomeInput, failures, lab, { round, version: (report.genome as GenomeInput)?.version ?? 1 });
        if (!r.check.ok) {
          const decision = decidePromotion(c.scores);
          const full = { ...report, scores: c.scores, outcomes: c.outcomes, decision, refine_failed: { round, errors: r.check.errors }, item_answers: await itemAnswersOf(env, c) };
          await updateDesign(env, c.design_id!, { status: "rejected", report: full });
          await audit(env.DB, STUDIO_ACTOR, "studio.reject", c.design_id, { brief: brief.id, reasons: decision.reasons, refine_errors: r.check.errors });
          await finishBrief(s, { brief_id: brief.id, design_id: c.design_id, status: "rejected", genome_id: c.genome_id, reasons: [...decision.reasons, ...r.check.errors.map((e) => `refine r${round}: ${e}`)], candidate: decision.candidate, strong: decision.strong, weak: decision.weak, rounds: round - 1 });
          return { message: `${brief.id}: refine r${round} failed the constitution check` };
        }
        const revisions = [...((report.revisions as unknown[]) ?? []), { round, genome_id: r.genome_id, source: r.source, note: r.note, failures: failures.map((f) => ({ key: f.key, cls: f.cls })) }];
        await updateDesign(env, c.design_id!, { genome_id: r.genome_id, report: { ...report, genome: r.genome, revisions, history: c.history } });
        c.genome_id = r.genome_id;
        c.scores.candidate = emptyScore();
        c.round = round;
        c.ui = 0;
        c.phase = "eval";
        s.extra_units = (s.extra_units ?? 0) + 1 + c.items.length;
        return { message: `${brief.id}: refined r${round} (${r.source}; ${failures.length} failing tasks → ${[...new Set(failures.map((f) => f.cls))].join(", ")})` };
      }

      // decide
      const decision = decidePromotion(c.scores);
      if (s.mode === "reeval") {
        const report = await designReport(env, c.design_id!);
        const of = String(report.reeval?.of_design ?? "");
        const verdict: "kept" | "flagged" = decision.promote ? "kept" : "flagged";
        const full = { ...report, scores: c.scores, outcomes: c.outcomes, decision, rounds: 0, item_answers: await itemAnswersOf(env, c), reeval: { ...(report.reeval ?? {}), verdict, flagged: !decision.promote, at: Date.now() } };
        // kept: the promoted genome still meets the gate on the updated suite (no new genome / service version).
        // flagged: it does not; the row is 'rejected' so the briefs list shows it, and the owner sees a studio.flag.
        await updateDesign(env, c.design_id!, { status: decision.promote ? "promoted" : "rejected", report: full, ...(decision.promote ? { promoted_at: Date.now() } : {}) });
        await audit(env.DB, STUDIO_ACTOR, decision.promote ? "studio.reeval" : "studio.flag", c.design_id, { brief: brief.id, of_design: of, genome: c.genome_id, verdict, reasons: decision.reasons, candidate: decision.candidate, strong: decision.strong, weak: decision.weak });
        await finishBrief(s, { brief_id: brief.id, design_id: c.design_id, status: decision.promote ? "promoted" : "rejected", genome_id: c.genome_id, reasons: decision.reasons, candidate: decision.candidate, strong: decision.strong, weak: decision.weak, rounds: 0, reeval: { of_design: of, verdict } });
        return { message: `${brief.id}: re-eval ${verdict.toUpperCase()} (capability ${decision.candidate.cap_rate}, safety ${decision.candidate.safety_rate})` };
      }
      if (!decision.promote) {
        const round = c.round ?? 0;
        const candFails = c.outcomes.some((o) => o.arm === "candidate" && !o.pass && (o.round ?? 0) === round);
        const rubric = c.items.filter((it) => (brief.tasks.find((t) => t.key === it.key)?.checker.type ?? "") === "rubric").length;
        const spent = s.llm_calls + (lab.calls - before) - (c.calls_at_start ?? 0);
        const budgetOk = spent + refineCost(c.items, rubric) <= STUDIO_CALLS_PER_BRIEF && lab.remaining >= 1;
        if (candFails && round < MAX_REFINE_ROUNDS && budgetOk && c.items.length) {
          (c.history ??= []).push({ round, genome_id: c.genome_id, candidate: decision.candidate, reasons: decision.reasons });
          c.phase = "refine";
          return { message: `${brief.id}: round ${round} not promotable (${decision.reasons.join("; ")}); refining` };
        }
      }
      const report = await designReport(env, c.design_id!);
      const full = { ...report, scores: c.scores, outcomes: c.outcomes, decision, history: c.history ?? [], rounds: c.round ?? 0, item_answers: await itemAnswersOf(env, c) };
      if (decision.promote && report.genome) {
        const p = await promoteDesign(env, { design_id: c.design_id!, brief, genome: report.genome as GenomeInput, decision, report: full });
        await finishBrief(s, { brief_id: brief.id, design_id: c.design_id, status: "promoted", genome_id: p.genome_id, service_version: p.service_version, reasons: decision.reasons, candidate: decision.candidate, strong: decision.strong, weak: decision.weak, rounds: c.round ?? 0 });
        return { message: `${brief.id}: PROMOTED (capability ${decision.candidate.cap_rate}, safety ${decision.candidate.safety_rate})` };
      }
      await updateDesign(env, c.design_id!, { status: "rejected", report: full });
      await audit(env.DB, STUDIO_ACTOR, "studio.reject", c.design_id, { brief: brief.id, reasons: decision.reasons });
      await finishBrief(s, { brief_id: brief.id, design_id: c.design_id, status: "rejected", genome_id: c.genome_id, reasons: decision.reasons, candidate: decision.candidate, strong: decision.strong, weak: decision.weak, rounds: c.round ?? 0 });
      return { message: `${brief.id}: rejected (${decision.reasons.join("; ")})` };
    } finally {
      s.llm_calls += lab.calls - before;
    }
  },
  isDone: (s) => s.bi >= s.brief_ids.length,
  progress: (s) => {
    const total = totalOf(s);
    return { done: Math.min(doneOf(s), total), total };
  },
  result: (s) => ({
    briefs: s.brief_ids.length,
    finished: s.results.length,
    promoted: s.results.filter((r) => r.status === "promoted").map((r) => r.brief_id),
    rejected: s.results.filter((r) => r.status === "rejected").map((r) => r.brief_id),
    failed: s.results.filter((r) => r.status === "failed").map((r) => r.brief_id),
    ...(s.mode === "reeval" ? { mode: "reeval", kept: s.results.filter((r) => r.reeval?.verdict === "kept").map((r) => r.brief_id), flagged: s.results.filter((r) => r.reeval?.verdict === "flagged").map((r) => r.brief_id) } : {}),
    current: s.cur ? { brief_id: s.cur.brief_id, design_id: s.cur.design_id, phase: s.cur.phase } : null,
    results: s.results,
    llm_calls: s.llm_calls,
  }),
  async onFinish(env, job, s, end) {
    // A design interrupted mid-way (budget / kill switch / cancel) is marked failed so it never looks in-flight.
    if (s.cur?.design_id) await updateDesign(env, s.cur.design_id, { status: "failed" }).catch(() => {});
    await audit(env.DB, STUDIO_ACTOR, "studio.design", job.id, {
      status: end.status,
      stopped: end.stopped ?? null,
      briefs: s.brief_ids.length,
      promoted: s.results.filter((r) => r.status === "promoted").length,
      rejected: s.results.filter((r) => r.status === "rejected").length,
      failed: s.results.filter((r) => r.status === "failed").length,
      llm_calls: end.llm_calls,
    }).catch(() => {});
  },
};

export const STUDIO_JOB_HANDLERS: Record<string, JobHandler> = { [STUDIO_DESIGN_KIND]: studioDesignJob };

/** Integration helper: registers the Studio job kinds in a handler table (jobs/handlers.ts HANDLERS). */
export function registerStudioHandlers(handlers: Record<string, JobHandler>): void {
  Object.assign(handlers, STUDIO_JOB_HANDLERS);
}
