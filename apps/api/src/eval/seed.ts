/**
 * Idempotent, resumable seeding of the 4 starter suites (research, code, critique, planning).
 * Target per suite: 6 public + 8 private + 2 canary ACTIVE items, generated from the suite's task families
 * (canaries from the safety family) and every one run through the full validation pipeline.
 *
 * Seeding is a small state machine (SeedCursor) advanced one candidate per `seedStep` call, so it can run
 * synchronously (seedEvalSuites, tests) or in chunks inside a background job (jobs.ts). Re-running only
 * fills what is missing: generation seeds are deterministic, so an item that already exists (in any status)
 * is detected by its hash and skipped without spending LLM calls.
 *
 * Difficulty escalation (calibration, not a weaker gate): when the weak baseline solves a candidate the item
 * is rejected as non-discriminative exactly as before, and the following candidates of that split are
 * generated one difficulty level higher (up to +MAX_BUMP, capped at 10). Replaying a run re-derives the same
 * bumps from the stored rejection reasons, so resuming is deterministic.
 */
import type { Env } from "../env";
import { FAMILY_MAP, STARTER_SUITES, familiesForSuite, type SuiteDef } from "./families";
import type { LabLLM } from "./llm";
import { countItems, ensureSuite, getItemByHash, itemHash } from "./store";
import type { ItemSpec, Split } from "./types";
import { validateItem, type ValidateOptions } from "./validate";

export const SEED_AUTHOR = "system:seed";
export const SEED_TARGETS: Record<Split, number> = { public: 6, private: 8, canary: 2 };
/** Difficulty rotation per split: public is the easier practice split, private the held-out one. */
const DIFFS: Record<Split, number[]> = { public: [1, 2, 3, 4, 2, 3], private: [3, 4, 5, 6, 4, 5, 6, 3], canary: [1] };
const MAX_ATTEMPTS_FACTOR = 4;
export const MAX_BUMP = 4;
const SPLIT_ORDER: Split[] = ["public", "private", "canary"];
const WEAK_PASS = "discriminative: weak baseline passes";

export interface SplitSummary {
  target: number;
  active: number;
  created: number;
  reserve: number;
  rejected: number;
  skipped_existing: number;
  /** current difficulty escalation for this split */
  bump: number;
}
export interface SuiteSeedSummary {
  suite_id: string;
  splits: Record<Split, SplitSummary>;
  rejections: string[];
}
export interface SeedSummary {
  suites: SuiteSeedSummary[];
  created: number;
  active: number;
  llm_calls: number;
  complete: boolean;
}

/** Serializable seeding position (stored in a job's state). */
export interface SeedCursor {
  suites: string[];
  si: number; // suite index
  sp: number; // split index into SPLIT_ORDER
  n: number; // next candidate number within the split
  started: boolean; // current split initialised (active count read)
  summaries: SuiteSeedSummary[];
  llm_calls: number;
  done: boolean;
}

/** Deterministic candidate n for (suite, split), escalated by `bump` difficulty levels. */
export function seedCandidate(suite: SuiteDef, split: Split, n: number, bump = 0): ItemSpec {
  if (split === "canary") {
    const g = FAMILY_MAP.safety.generate(`seed:${suite.id}:canary:${n}`, 1, n);
    return { suite_id: suite.id, task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: 1, tags: [...g.tags, "canary"], split };
  }
  const fams = familiesForSuite(suite.id);
  if (!fams.length) throw new Error(`suite ${suite.id} has no task families`);
  const fam = fams[n % fams.length];
  const d = Math.min(10, DIFFS[split][n % DIFFS[split].length] + Math.max(0, bump));
  const seed = bump > 0 ? `seed:${suite.id}:${split}:${n}:b${bump}` : `seed:${suite.id}:${split}:${n}`;
  const g = fam.generate(seed, d);
  return { suite_id: suite.id, task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: d, tags: bump > 0 ? [...g.tags, `escalated+${bump}`] : g.tags, split };
}

async function activeCount(env: Env, suiteId: string, split: Split): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM eval_items WHERE suite_id = ?1 AND split = ?2 AND status = 'active' AND author = ?3")
    .bind(suiteId, split, SEED_AUTHOR)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const suiteDef = (id: string) => STARTER_SUITES.find((s) => s.id === id);

export function newSeedCursor(suites: SuiteDef[] = STARTER_SUITES): SeedCursor {
  return { suites: suites.map((s) => s.id), si: 0, sp: 0, n: 0, started: false, summaries: [], llm_calls: 0, done: suites.length === 0 };
}

/** Upper bound on candidates the cursor may still visit (for progress bars). */
export function seedTotal(c: SeedCursor): number {
  return c.suites.length * SPLIT_ORDER.reduce((a, s) => a + SEED_TARGETS[s], 0);
}
/** Active items reached so far (progress numerator; counts pre-existing active items once a split starts). */
export function seedProgress(c: SeedCursor): number {
  return c.summaries.reduce((a, s) => a + Object.values(s.splits).reduce((b, x) => b + Math.min(x.active, x.target), 0), 0);
}

export interface SeedStepInfo {
  /** true when this step validated a candidate (and so may have spent LLM calls) */
  validated: boolean;
  message: string;
}

/**
 * Advance the cursor by one unit of work: initialise a split, skip one existing candidate, or validate one
 * new candidate (≈2-8 LLM calls). Mutates and returns the cursor.
 */
export async function seedStep(env: Env, lab: LabLLM, c: SeedCursor, opts: Omit<ValidateOptions, "author" | "persist"> = {}): Promise<SeedStepInfo> {
  if (c.done) return { validated: false, message: "done" };
  if (c.si >= c.suites.length) {
    c.done = true;
    return { validated: false, message: "done" };
  }
  const suite = suiteDef(c.suites[c.si]);
  if (!suite) throw new Error(`unknown suite '${c.suites[c.si]}'`);
  const split = SPLIT_ORDER[c.sp];
  let sum = c.summaries.find((s) => s.suite_id === suite.id);
  if (!sum) {
    await ensureSuite(env, suite);
    sum = { suite_id: suite.id, splits: {} as Record<Split, SplitSummary>, rejections: [] };
    c.summaries.push(sum);
  }
  if (!c.started) {
    sum.splits[split] = { target: SEED_TARGETS[split], active: await activeCount(env, suite.id, split), created: 0, reserve: 0, rejected: 0, skipped_existing: 0, bump: 0 };
    c.started = true;
    c.n = 0;
  }
  const s = sum.splits[split];
  const next = () => {
    c.sp++;
    c.started = false;
    c.n = 0;
    if (c.sp >= SPLIT_ORDER.length) {
      c.sp = 0;
      c.si++;
      if (c.si >= c.suites.length) c.done = true;
    }
  };
  if (s.active >= s.target || c.n >= s.target * MAX_ATTEMPTS_FACTOR) {
    next();
    return { validated: false, message: `${suite.id}/${split}: ${s.active}/${s.target} active` };
  }
  const n = c.n++;
  const spec = seedCandidate(suite, split, n, s.bump);
  const existing = await getItemByHash(env, await itemHash(spec.suite_id, spec.task, spec.inputs));
  if (existing) {
    s.skipped_existing++;
    if (existing.status_reason === WEAK_PASS) s.bump = Math.min(MAX_BUMP, s.bump + 1);
    return { validated: false, message: `${suite.id}/${split}#${n}: exists (${existing.status})` };
  }
  const before = lab.calls;
  const v = await validateItem(env, lab, spec, { ...opts, author: SEED_AUTHOR });
  c.llm_calls += lab.calls - before;
  if (v.item) s.created++;
  if (v.status === "active") s.active++;
  else if (v.status === "reserve") s.reserve++;
  else {
    s.rejected++;
    sum.rejections.push(`${split}#${n} d${spec.difficulty}: ${v.reason}`);
    if (sum.rejections.length > 60) sum.rejections.splice(0, sum.rejections.length - 60);
    if (v.reason === WEAK_PASS) s.bump = Math.min(MAX_BUMP, s.bump + 1);
  }
  return { validated: true, message: `${suite.id}/${split}#${n} d${spec.difficulty}: ${v.status}${v.reason ? ` (${v.reason})` : ""}` };
}

export function seedSummaryOf(c: SeedCursor): SeedSummary {
  const created = c.summaries.reduce((a, s) => a + Object.values(s.splits).reduce((b, x) => b + x.created, 0), 0);
  const active = c.summaries.reduce((a, s) => a + Object.values(s.splits).reduce((b, x) => b + x.active, 0), 0);
  const complete =
    c.summaries.length === c.suites.length &&
    c.summaries.every((s) => SPLIT_ORDER.every((sp) => s.splits[sp] && s.splits[sp].active >= s.splits[sp].target));
  return { suites: c.summaries, created, active, llm_calls: c.llm_calls, complete };
}

export async function seedSuite(env: Env, lab: LabLLM, suite: SuiteDef, opts: Omit<ValidateOptions, "author" | "persist"> = {}): Promise<SuiteSeedSummary> {
  const c = newSeedCursor([suite]);
  while (!c.done) await seedStep(env, lab, c, opts);
  return c.summaries[0];
}

/** Seed every starter suite synchronously. Safe to call repeatedly. Long-running: prefer the seed job. */
export async function seedEvalSuites(env: Env, lab: LabLLM, opts: { suites?: SuiteDef[] } & Omit<ValidateOptions, "author" | "persist"> = {}): Promise<SeedSummary> {
  const { suites, ...vopts } = opts;
  const c = newSeedCursor(suites ?? STARTER_SUITES);
  while (!c.done) await seedStep(env, lab, c, vopts);
  return seedSummaryOf(c);
}

export { countItems };
