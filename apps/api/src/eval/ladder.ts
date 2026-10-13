/**
 * Difficulty ladder + flake retirement.
 *
 *  - checkSaturation: run the role champion over the suite's active PRIVATE items. Pass rate > 0.9 means
 *    the suite no longer separates good from great → authorHarder.
 *  - authorHarder: generate items at (suite level + 2, capped at 10) from the suite's task families, run
 *    each through the full validation pipeline, raise the suite level, and (when the registry has an
 *    Evaluator agent, `a_evaluator`) queue it an AUTHOR_EVAL_ITEMS task so LLM-authored items join too.
 *  - recheck / retireFlaky: an item whose verdict for the SAME genome disagrees across reruns at least
 *    twice is retired (a flaky item cannot be trusted to rank genomes).
 */
import type { Env } from "../env";
import type { Genome } from "../genome/schema";
import { home } from "../home/stub";
import { strongBaseline } from "./baselines";
import { familiesForSuite } from "./families";
import type { LabLLM } from "./llm";
import { authorTaskText } from "./prompts";
import { attempt, type SolverGenome } from "./solver";
import { bumpChecks, getItem, getSuite, listItems, listPublicItems, recordResult, resultsFor, setItemStatus, updateSuite } from "./store";
import type { EvalItem, ItemSpec } from "./types";
import { championGenome, validateItem, type ValidateOptions } from "./validate";

export const SATURATION_THRESHOLD = 0.9;
export const FLAKE_RETIRE_AT = 2;
export const LADDER_AUTHOR = "system:ladder";
export const EVALUATOR_AGENT = "a_evaluator";

export type Enqueue = (agentId: string, task: string) => Promise<string>;

export interface LadderResult {
  suite_id: string;
  from_level: number;
  level: number;
  difficulty: number;
  attempted: number;
  active: string[];
  reserve: string[];
  rejected: { n: number; reason?: string }[];
  evaluator_run: string | null;
}

export interface SaturationResult {
  suite_id: string;
  genome_id: string;
  n: number;
  passed: number;
  pass_rate: number;
  saturated: boolean;
  ladder: LadderResult | null;
}

async function solverFor(env: Env, role: EvalItem["role"], g?: SolverGenome): Promise<SolverGenome> {
  return g ?? (await championGenome(env, role)) ?? (await strongBaseline(role));
}

/** Default evaluator hand-off: queue the task on the agent's home (only if that agent exists and can run). */
async function defaultEnqueue(env: Env): Promise<Enqueue | null> {
  const a = await env.DB.prepare("SELECT status FROM agents WHERE id = ?1").bind(EVALUATOR_AGENT).first<{ status: string }>();
  if (!a || !["sandboxed", "candidate", "champion"].includes(a.status)) return null;
  return (agentId, task) => home(env, agentId).enqueue(agentId, task);
}

// ---------------- difficulty ladder (resumable cursor) ----------------

/** Serializable position of an authorHarder run (stored in a job's state). */
export interface LadderCursor {
  suite_id: string;
  from_level: number;
  difficulty: number;
  count: number;
  n: number;
  out: LadderResult;
  done: boolean;
}

export async function ladderInit(env: Env, suiteId: string, opts: { count?: number; difficulty?: number } = {}): Promise<LadderCursor> {
  const suite = await getSuite(env, suiteId);
  if (!suite) throw new Error(`unknown suite '${suiteId}'`);
  const difficulty = Math.min(10, Math.max(1, opts.difficulty ?? suite.level + 2));
  const count = Math.max(1, opts.count ?? 3);
  const out: LadderResult = { suite_id: suiteId, from_level: suite.level, level: suite.level, difficulty, attempted: 0, active: [], reserve: [], rejected: [], evaluator_run: null };
  return { suite_id: suiteId, from_level: suite.level, difficulty, count, n: 0, out, done: false };
}

const ladderMore = (c: LadderCursor, famCount: number) => famCount > 0 && c.out.active.length + c.out.reserve.length < c.count && c.n < c.count * 3;

/** Validate one ladder candidate. Returns false (and does nothing) when no candidate is left. */
export async function ladderStep(env: Env, lab: LabLLM, c: LadderCursor, validate: Omit<ValidateOptions, "author" | "persist"> = {}): Promise<boolean> {
  const fams = familiesForSuite(c.suite_id);
  if (!ladderMore(c, fams.length)) return false;
  const n = c.n++;
  const fam = fams[(n + c.from_level) % fams.length];
  const g = fam.generate(`ladder:${c.suite_id}:${c.difficulty}:${n}`, c.difficulty);
  const spec: ItemSpec = { suite_id: c.suite_id, task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: c.difficulty, tags: [...g.tags, "ladder"], split: "private" };
  c.out.attempted++;
  const v = await validateItem(env, lab, spec, { ...validate, author: LADDER_AUTHOR });
  if (v.status === "active") c.out.active.push(v.item_id);
  else if (v.status === "reserve") c.out.reserve.push(v.item_id);
  else c.out.rejected.push({ n, reason: v.reason });
  return true;
}

/** Raise the suite level and hand off to the Evaluator agent (no LLM calls). */
export async function ladderFinish(env: Env, c: LadderCursor, enqueueOpt?: Enqueue | null): Promise<LadderResult> {
  const suite = (await getSuite(env, c.suite_id))!;
  const fams = familiesForSuite(c.suite_id);
  c.out.level = Math.max(suite.level, c.difficulty);
  await updateSuite(env, c.suite_id, { level: c.out.level, ladder_requested_at: Date.now() });
  const enqueue = enqueueOpt === undefined ? await defaultEnqueue(env) : enqueueOpt;
  if (enqueue) {
    const examples = (await listPublicItems(env, c.suite_id, 3)).map((i) => ({ task: i.task, difficulty: i.difficulty }));
    const text = authorTaskText(c.suite_id, suite.role, c.difficulty, fams.map((f) => f.kind), examples);
    try {
      c.out.evaluator_run = await enqueue(EVALUATOR_AGENT, text);
    } catch {
      c.out.evaluator_run = null; // the evaluator hand-off is best-effort; generated items already landed
    }
  }
  c.done = true;
  return c.out;
}

export async function authorHarder(
  env: Env,
  lab: LabLLM,
  suiteId: string,
  opts: { count?: number; difficulty?: number; enqueue?: Enqueue | null; validate?: Omit<ValidateOptions, "author" | "persist"> } = {},
): Promise<LadderResult> {
  const c = await ladderInit(env, suiteId, opts);
  while (await ladderStep(env, lab, c, opts.validate)) {}
  return ladderFinish(env, c, opts.enqueue);
}

// ---------------- saturation (resumable cursor) ----------------

/** Serializable position of a saturation check (stored in a job's state). */
export interface SaturationCursor {
  suite_id: string;
  genome: SolverGenome;
  item_ids: string[];
  i: number;
  passed: number;
  ref: string;
  threshold: number;
  min_items: number;
  ladder_enabled: boolean;
  count?: number;
  phase: "solve" | "ladder" | "done";
  ladder: LadderCursor | null;
  result: SaturationResult | null;
}

export async function saturationInit(
  env: Env,
  suiteId: string,
  opts: { genome?: SolverGenome; threshold?: number; minItems?: number; ladder?: boolean; count?: number } = {},
): Promise<SaturationCursor> {
  const suite = await getSuite(env, suiteId);
  if (!suite) throw new Error(`unknown suite '${suiteId}'`);
  const g = await solverFor(env, suite.role, opts.genome);
  const genome: SolverGenome = { id: g.id, system_prompt: g.system_prompt, planning_strategy: g.planning_strategy, skills: g.skills, role: g.role, model_policy: g.model_policy, lineage_id: g.lineage_id };
  const items = await listItems(env, { suite_id: suiteId, status: "active", split: "private" });
  return {
    suite_id: suiteId,
    genome,
    item_ids: items.map((i) => i.id),
    i: 0,
    passed: 0,
    ref: `sat:${Date.now()}`,
    threshold: opts.threshold ?? SATURATION_THRESHOLD,
    min_items: opts.minItems ?? 5,
    ladder_enabled: opts.ladder !== false,
    count: opts.count,
    phase: "solve",
    ladder: null,
    result: null,
  };
}

/** Units of work for a progress bar: items to solve (+ ladder candidates once laddering starts). */
export const saturationTotal = (c: SaturationCursor) => c.item_ids.length + (c.ladder ? c.ladder.count * 3 : 0);
export const saturationDone = (c: SaturationCursor) => c.i + (c.ladder ? c.ladder.n : 0);

/** One unit: solve one held-out item, or compute the verdict, or validate one ladder candidate. */
export async function saturationStep(
  env: Env,
  lab: LabLLM,
  c: SaturationCursor,
  opts: { enqueue?: Enqueue | null; validate?: Omit<ValidateOptions, "author" | "persist"> } = {},
): Promise<void> {
  if (c.phase === "solve") {
    if (c.i < c.item_ids.length) {
      const it = await getItem(env, c.item_ids[c.i]);
      if (it && it.status === "active") {
        const a = await attempt(lab, c.genome, it);
        if (a.verdict.pass) c.passed++;
        await recordResult(env, { item_id: it.id, genome_id: c.genome.id, context: "saturation", ref: c.ref, pass: a.verdict.pass, score: a.verdict.score, answer: a.answer, tokens: a.tokens });
      } // an item retired meanwhile counts as not passed (keeps n stable for this run)
      c.i++;
      return;
    }
    const n = c.item_ids.length;
    const pass_rate = n ? Math.round((c.passed / n) * 1000) / 1000 : 0;
    const saturated = n >= c.min_items && pass_rate > c.threshold;
    await updateSuite(env, c.suite_id, { saturation: pass_rate, saturation_genome: c.genome.id, ...(saturated ? { saturated_at: Date.now() } : {}) });
    c.result = { suite_id: c.suite_id, genome_id: c.genome.id, n, passed: c.passed, pass_rate, saturated, ladder: null };
    if (saturated && c.ladder_enabled) {
      c.ladder = await ladderInit(env, c.suite_id, { count: c.count });
      c.phase = "ladder";
    } else c.phase = "done";
    return;
  }
  if (c.phase === "ladder" && c.ladder) {
    if (!(await ladderStep(env, lab, c.ladder, opts.validate))) {
      c.result!.ladder = await ladderFinish(env, c.ladder, opts.enqueue);
      c.phase = "done";
    }
  }
}

export async function checkSaturation(
  env: Env,
  lab: LabLLM,
  suiteId: string,
  opts: { genome?: SolverGenome; threshold?: number; minItems?: number; ladder?: boolean; count?: number; enqueue?: Enqueue | null; validate?: Omit<ValidateOptions, "author" | "persist"> } = {},
): Promise<SaturationResult> {
  const c = await saturationInit(env, suiteId, opts);
  while (c.phase !== "done") await saturationStep(env, lab, c, opts);
  return c.result!;
}

// ---------------- flakes ----------------

/** Number of verdict flips between consecutive results of the same genome on an item (max over genomes). */
export function disagreements(results: { genome_id: string; pass: boolean }[]): number {
  const last = new Map<string, boolean>();
  const flips = new Map<string, number>();
  for (const r of results) {
    const prev = last.get(r.genome_id);
    if (prev !== undefined && prev !== r.pass) flips.set(r.genome_id, (flips.get(r.genome_id) ?? 0) + 1);
    last.set(r.genome_id, r.pass);
  }
  return Math.max(0, ...flips.values());
}

export interface RecheckResult {
  item_id: string;
  pass: boolean;
  flaked: boolean;
  checks: number;
  flakes: number;
  retired: boolean;
}

/** Re-run one item with a genome; a verdict that differs from that genome's previous verdict is a flake. */
export async function recheckItem(env: Env, lab: LabLLM, item: EvalItem, genome: SolverGenome | Genome): Promise<RecheckResult> {
  const prev = (await resultsFor(env, item.id, { genome_id: genome.id })).at(-1);
  const a = await attempt(lab, genome, item);
  await recordResult(env, { item_id: item.id, genome_id: genome.id, context: "recheck", pass: a.verdict.pass, score: a.verdict.score, answer: a.answer, tokens: a.tokens });
  const flaked = !!prev && prev.pass !== a.verdict.pass;
  const { checks, flakes } = await bumpChecks(env, item.id, flaked);
  let retired = false;
  if (flakes >= FLAKE_RETIRE_AT && item.status !== "retired") {
    await setItemStatus(env, item.id, "retired", { reason: `flaky: verdict changed across reruns ${flakes} times` });
    retired = true;
  }
  return { item_id: item.id, pass: a.verdict.pass, flaked, checks, flakes, retired };
}

/** Re-check every active item of a suite with the champion (or a given genome). */
export async function recheckSuite(env: Env, lab: LabLLM, suiteId: string, opts: { genome?: SolverGenome; limit?: number } = {}): Promise<RecheckResult[]> {
  const suite = await getSuite(env, suiteId);
  if (!suite) throw new Error(`unknown suite '${suiteId}'`);
  const g = await solverFor(env, suite.role, opts.genome);
  const out: RecheckResult[] = [];
  for (const it of await listItems(env, { suite_id: suiteId, status: "active", limit: opts.limit ?? 200 })) out.push(await recheckItem(env, lab, it, g));
  return out;
}

/**
 * Scan recorded results (all contexts) and retire every active/reserve item whose verdicts for one genome
 * flipped ≥ FLAKE_RETIRE_AT times. No LLM calls. Returns the retired item ids.
 */
export async function retireFlaky(env: Env, suiteId?: string): Promise<{ retired: string[]; scanned: number }> {
  const items = await listItems(env, { suite_id: suiteId, status: ["active", "reserve"], limit: 5000 });
  const retired: string[] = [];
  for (const it of items) {
    const flips = disagreements(await resultsFor(env, it.id, { limit: 1000 }));
    if (flips > it.flakes) await env.DB.prepare("UPDATE eval_items SET flakes = ?2, updated_at = ?3 WHERE id = ?1").bind(it.id, flips, Date.now()).run();
    if (Math.max(flips, it.flakes) >= FLAKE_RETIRE_AT) {
      await setItemStatus(env, it.id, "retired", { reason: `flaky: verdict changed across reruns ${Math.max(flips, it.flakes)} times` });
      retired.push(it.id);
    }
  }
  return { retired, scanned: items.length };
}
