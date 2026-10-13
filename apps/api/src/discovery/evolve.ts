/**
 * Discovery Lab program-evolution engine (ARCHITECTURE §17, AlphaEvolve/FunSearch-style on free tiers).
 *
 *  - Islands: each problem keeps `islands` independent populations (default 3). One step works on one
 *    island (generation % islands); every `migrateEvery` generations the island's best program is copied
 *    to the next island.
 *  - MAP-Elites archive per island: cell = scoreBucket × programLengthBucket × behaviourBucket. A child
 *    takes a cell when it is empty or the child beats the cell's elite (ties → shorter code).
 *  - Parents: tournament(3) over the island's elites (70%) or a uniform elite (30%, exploration).
 *  - Operators, chosen by a Thompson bandit (success = child strictly beats its parent):
 *      tweak (deterministic parameter tweak), crossover (function swap / knob swap with a second elite or a
 *      top program of another island), llm (Researcher prompt → full program in a ```js block).
 *    Without an LLM (off, budget used, or kill switch) the engine keeps working with the deterministic ones.
 *  - Evaluation: construct(input) in a fresh QuickJS sandbox (fuel-capped) → runVerifier → score.
 *  - Records: a child that beats the best record becomes a 'candidate' certificate (store.ts verifies it).
 *
 * stepGeneration() does a bounded amount of work (≤ `children` sandbox evaluations, default 2) so the job
 * runner can drive it in small chunks under the free plan's CPU limit.
 */
import type { Env } from "../env";
import { LabBudgetError, type LabLLM } from "../eval/llm";
import { hashSeed, mulberry32, ThompsonBandit, type BanditJSON, type Rng } from "../evolution/bandit";
import { runSandboxed } from "../forge/sandbox";
import { runVerifier, verifierHash } from "../forge/tool";
import { mockProgramBrain } from "./mockProgramBrain";
import { crossover, extractProgram, mutationPrompt, programProblems, tweak } from "./mutate";
import { getBuiltinProblem } from "./problems";
import {
  bestRecord,
  better,
  defFromRow,
  demoteElite,
  elitesOf,
  getProblemRow,
  insertProgram,
  insertRecord,
  programExists,
  programHash,
  saveEvolutionState,
  topPrograms,
  upsertProblem,
  type ProblemRow,
  type ProgramRow,
  type RecordRow,
} from "./store";
import type { OperatorId, ProblemDef } from "./types";

export const DISCOVERY_AGENT = "lab:discovery";
export const OPERATORS: OperatorId[] = ["tweak", "crossover", "llm"];
export const DISCOVERY_DEFAULTS = Object.freeze({
  children: 2,
  maxChildren: 16,
  constructFuel: 400,
  verifyFuel: 300,
  migrateEvery: 5,
  islands: 3,
});

/**
 * Profile for the Workers free plan (10 ms CPU per invocation). Measured locally in Node with the same
 * QuickJS-WASM build (work/discovery-bench/bench-results.txt, 2026-10-12): a fresh runtime + trivial call
 * ≈ 0.3 ms; built-in verifier runs median 0.45–2 ms (≤ 6 fuel ticks); seed constructs 0.4–22 ms; roughly
 * 0.7 fuel ticks per ms. One child per invocation with ~8 ticks per sandbox run stays near the limit; heavier
 * programs simply fail with a fuel error and are recorded as invalid (never a crash). Use the larger
 * DISCOVERY_DEFAULTS on paid plans / local runs.
 */
export const DISCOVERY_FREE_PLAN = Object.freeze({ children: 1, constructFuel: 8, verifyFuel: 8 });

export type LlmFn = (prompt: { system: string; user: string }) => Promise<string>;

export interface StepOptions {
  /** Children evaluated in this step (the seed evaluation of an empty island counts as one). Default 2, max 16. */
  children?: number;
  /** Step seed (deterministic operator choices / tweaks for the same state + seed). */
  seed?: number | string;
  /** Force an island (default generation % islands). */
  island?: number;
  /** "auto" (default): use the LabLLM (mock brain in mock mode); "off": deterministic operators only; or a custom fn. */
  llm?: "auto" | "off" | LlmFn;
  constructFuel?: number;
  verifyFuel?: number;
  migrateEvery?: number;
  /** Agent id the LLM calls are charged to (default lab:discovery). */
  agentId?: string;
}

export interface EvalResult {
  valid: boolean;
  score: number | null;
  solution: unknown;
  detail?: string;
  error?: string;
  constructMs: number;
  verifyMs: number;
  fuelUsed: number;
  verifierHash?: string;
}

export interface ChildReport {
  id?: string;
  op: OperatorId | "seed" | "migration";
  note?: string;
  valid: boolean;
  score: number | null;
  parentScore: number | null;
  improved: boolean;
  elite: boolean;
  cell?: string;
  duplicate?: boolean;
  error?: string;
  constructMs: number;
  verifyMs: number;
}

export interface StepResult {
  problemId: string;
  generation: number;
  island: number;
  evaluated: number;
  children: ChildReport[];
  newRecord?: { id: string; score: number; vs_known: string };
  best: number | null;
  llmCalls: number;
  llmDisabledReason?: string;
  migrated?: { from: number; to: number; programId: string };
  /** Sum of sandbox ms reported by the runs (wall-clock; inside workerd the clock only advances on I/O). */
  sandboxMs: number;
}

// ---------------- evaluation ----------------
/** construct(instance) in a fresh sandbox, then the verifier on its output. Never throws. */
export async function evaluateProgram(def: ProblemDef, code: string, o: { seed?: number; constructFuel?: number; verifyFuel?: number } = {}): Promise<EvalResult> {
  const probs = programProblems(code);
  if (probs.length) return { valid: false, score: null, solution: null, error: probs.join("; "), constructMs: 0, verifyMs: 0, fuelUsed: 0 };
  const r = await runSandboxed({
    code,
    entry: "construct",
    input: def.instance,
    limits: { fuel: o.constructFuel ?? def.limits?.constructFuel ?? DISCOVERY_DEFAULTS.constructFuel, seed: o.seed ?? 1, maxOutputBytes: 256 * 1024, maxInputBytes: 256 * 1024 },
  });
  if (!r.ok) return { valid: false, score: null, solution: null, error: `construct ${r.errorKind}: ${r.error}`, constructMs: r.ms, verifyMs: 0, fuelUsed: r.fuelUsed };
  const v = await runVerifier(def.verifier, r.value, { instance: def.instance, seed: o.seed ?? 1, limits: { fuel: o.verifyFuel ?? def.limits?.verifyFuel ?? DISCOVERY_DEFAULTS.verifyFuel, maxInputBytes: 256 * 1024 } });
  return {
    valid: v.valid,
    score: v.valid ? v.score : null,
    solution: r.value,
    detail: v.detail,
    error: v.valid ? undefined : v.detail ?? "invalid",
    constructMs: r.ms,
    verifyMs: v.ms,
    fuelUsed: r.fuelUsed + v.fuelUsed,
    verifierHash: v.verifierHash,
  };
}

// ---------------- MAP-Elites cells ----------------
export function scoreBucket(def: ProblemDef, score: number | null): number {
  if (score === null || !Number.isFinite(score)) return 0;
  const bk = def.best_known.score;
  let q: number;
  if (bk !== null && bk > 0 && score > 0) q = def.direction === "max" ? score / bk : bk / score;
  else q = def.direction === "max" ? 1 - 1 / (1 + Math.abs(score)) : 1 / (1 + Math.abs(score));
  return Math.max(0, Math.min(9, Math.floor(q * 8)));
}

export function lengthBucket(code: string): number {
  const n = code.length;
  return n < 800 ? 0 : n < 1600 ? 1 : n < 3200 ? 2 : n < 6400 ? 3 : 4;
}

export function behaviourBucket(def: ProblemDef, solution: unknown): number {
  if (!def.describe || solution === null || solution === undefined) return 0;
  try {
    const x = def.describe(solution, def.instance);
    return Number.isFinite(x) ? Math.max(0, Math.min(3, Math.floor(x * 4))) : 0;
  } catch {
    return 0;
  }
}

export function cellOf(def: ProblemDef, code: string, ev: Pick<EvalResult, "valid" | "score" | "solution">): string | null {
  if (!ev.valid) return null;
  return `${scoreBucket(def, ev.score)}.${lengthBucket(code)}.${behaviourBucket(def, ev.solution)}`;
}

/** a is a better elite than b (score, then shorter code). */
function eliteBetter(def: ProblemDef, a: { score: number | null; code: string }, b: { score: number | null; code: string }): boolean {
  if (a.score === null) return false;
  if (b.score === null) return true;
  const tol = def.tolerance ?? 1e-9;
  if (better(def.direction, a.score, b.score, tol)) return true;
  if (better(def.direction, b.score, a.score, tol)) return false;
  // equal score: the shorter program wins; an equally long one replaces the incumbent (neutral drift
  // lets the archive walk across plateaus instead of freezing on the first program that reached them)
  return a.code.length <= b.code.length;
}

export function selectParent(def: ProblemDef, elites: ProgramRow[], rng: Rng): ProgramRow {
  const pool = elites.filter((e) => e.valid);
  const from = pool.length ? pool : elites;
  if (rng() < 0.3 || from.length < 2) return from[Math.floor(rng() * from.length)];
  let best: ProgramRow | null = null;
  for (let i = 0; i < 3; i++) {
    const c = from[Math.floor(rng() * from.length)];
    if (!best || eliteBetter(def, c, best)) best = c;
  }
  return best!;
}

// ---------------- problem resolution ----------------
/** Load (and for builtins, register/refresh) a problem. */
export async function ensureProblem(env: Env, problemId: string, islands = DISCOVERY_DEFAULTS.islands): Promise<{ def: ProblemDef; row: ProblemRow }> {
  const builtin = getBuiltinProblem(problemId);
  let row = await getProblemRow(env, problemId);
  if (builtin) {
    if (!row || row.verifier_hash !== (await verifierHash(builtin.verifier)) || row.best_known_score !== builtin.best_known.score || row.seed_program !== builtin.seed_program) {
      row = await upsertProblem(env, builtin, { islands });
    }
    return { def: builtin, row };
  }
  if (!row) throw new Error(`unknown problem ${problemId}`);
  return { def: defFromRow(row), row };
}

const evalSeedOf = (problemId: string) => (hashSeed(`${problemId}:eval`) % 1_000_000) + 1;

// ---------------- one bounded step ----------------
export async function stepGeneration(env: Env, lab: LabLLM | null, problemId: string, opts: StepOptions = {}): Promise<StepResult> {
  const { def, row } = await ensureProblem(env, problemId);
  if (row.status !== "active") throw new Error(`problem ${problemId} is ${row.status}`);
  const gen = row.generation;
  const islands = Math.max(1, row.islands);
  const island = opts.island !== undefined ? ((Math.floor(opts.island) % islands) + islands) % islands : gen % islands;
  const children = Math.max(1, Math.min(DISCOVERY_DEFAULTS.maxChildren, Math.floor(opts.children ?? DISCOVERY_DEFAULTS.children)));
  const fuel = { constructFuel: opts.constructFuel ?? def.limits?.constructFuel, verifyFuel: opts.verifyFuel ?? def.limits?.verifyFuel };
  const evalSeed = evalSeedOf(def.id);
  const rng = mulberry32(hashSeed(`${def.id}|${gen}|${island}|${opts.seed ?? 0}`));
  const tol = def.tolerance ?? 1e-9;
  const agentId = opts.agentId ?? DISCOVERY_AGENT;

  let bandit: ThompsonBandit;
  try {
    bandit = row.bandit ? ThompsonBandit.fromJSON(JSON.parse(row.bandit) as BanditJSON) : new ThompsonBandit(OPERATORS);
  } catch {
    bandit = new ThompsonBandit(OPERATORS);
  }
  for (const op of OPERATORS) bandit.addArm(op);

  let llmMode: "off" | "lab" | "custom" = opts.llm === "off" ? "off" : typeof opts.llm === "function" ? "custom" : lab ? "lab" : "off";
  let llmDisabledReason: string | undefined = llmMode === "off" ? "llm off" : undefined;
  let llmCalls = 0;

  const result: StepResult = { problemId: def.id, generation: gen, island, evaluated: 0, children: [], best: null, llmCalls: 0, sandboxMs: 0 };
  let elites = await elitesOf(env, def.id, island);
  let best: RecordRow | null = await bestRecord(env, def.id, def.direction);
  const problemRow = row;

  /** Insert an evaluated program into the island's archive (elite placement) and maybe a record. */
  const place = async (code: string, ev: EvalResult, meta: { op: ChildReport["op"]; parent: ProgramRow | null; second?: ProgramRow | null; lineage: string; note?: string; targetIsland?: number }): Promise<ChildReport> => {
    const isl = meta.targetIsland ?? island;
    const cell = cellOf(def, code, ev);
    const arch = isl === island ? elites : await elitesOf(env, def.id, isl);
    const incumbent = cell ? arch.find((e) => e.cell === cell) : undefined;
    const takes = !!cell && (!incumbent || eliteBetter(def, { score: ev.score, code }, incumbent));
    // an island whose only programs are invalid keeps one invalid elite so it always has a parent
    const keepInvalid = !cell && arch.length === 0;
    const rowIn = await insertProgram(env, {
      problem_id: def.id,
      island: isl,
      hash: await programHash(code),
      code,
      score: ev.score,
      valid: ev.valid ? 1 : 0,
      cell,
      elite: takes || keepInvalid ? 1 : 0,
      parent_id: meta.parent?.id ?? null,
      second_parent_id: meta.second?.id ?? null,
      operator: meta.op,
      lineage: meta.lineage,
      generation: gen,
      eval_seed: evalSeed,
      solution: ev.valid ? JSON.stringify(ev.solution) : null,
      error: ev.error ? ev.error.slice(0, 500) : null,
      construct_ms: ev.constructMs,
      verify_ms: ev.verifyMs,
      fuel_used: ev.fuelUsed,
    });
    if (takes) {
      // a valid elite replaces an invalid placeholder too
      for (const e of arch.filter((e) => (incumbent && e.id === incumbent.id) || (!e.valid && e.elite))) await demoteElite(env, e.id);
      const next = arch.filter((e) => !(incumbent && e.id === incumbent.id) && e.valid);
      next.push(rowIn);
      if (isl === island) elites = next;
    } else if (keepInvalid && isl === island) elites = [rowIn];
    const parentScore = meta.parent?.valid ? meta.parent.score : null;
    const improved = ev.valid && (parentScore === null || better(def.direction, ev.score!, parentScore, tol));
    if (ev.valid && ev.score !== null && (!best || better(def.direction, ev.score, best.score, tol))) {
      best = await insertRecord(env, problemRow, { score: ev.score, program_id: rowIn.id, solution: ev.solution, verifier_hash: ev.verifierHash ?? problemRow.verifier_hash, eval_seed: evalSeed, lineage: meta.lineage });
      result.newRecord = { id: best.id, score: best.score, vs_known: best.vs_known };
    }
    result.sandboxMs += ev.constructMs + ev.verifyMs;
    return { id: rowIn.id, op: meta.op, note: meta.note, valid: ev.valid, score: ev.score, parentScore, improved, elite: takes, cell: cell ?? undefined, error: ev.error, constructMs: ev.constructMs, verifyMs: ev.verifyMs };
  };

  let budget = children;
  if (!elites.length) {
    // empty island: seed it (from the best program anywhere, else the problem's seed program)
    const [top] = await topPrograms(env, def.id, def.direction, 1);
    const code = top?.code ?? def.seed_program;
    if (!(await programExists(env, def.id, island, await programHash(code)))) {
      const ev = await evaluateProgram(def, code, { seed: evalSeed, ...fuel });
      result.children.push(await place(code, ev, { op: top ? "migration" : "seed", parent: top ?? null, lineage: top?.lineage ?? "seed" }));
      result.evaluated++;
      budget--;
    }
    if (!elites.length) elites = await elitesOf(env, def.id, island);
  }

  const inspirations = await topPrograms(env, def.id, def.direction, 3);

  for (let i = 0; i < budget && elites.length; i++) {
    const parent = selectParent(def, elites, rng);
    const allowed = OPERATORS.filter((op) => op !== "llm" || llmMode !== "off");
    const sub = ThompsonBandit.fromJSON({ prior: bandit.prior, arms: Object.fromEntries(allowed.map((a) => [a, bandit.get(a)!])) });
    let op = sub.choose(`${def.id}|${gen}|${island}|${i}|${opts.seed ?? 0}`) as OperatorId;

    let code: string | null = null;
    let note: string | undefined;
    let second: ProgramRow | null = null;
    let lineage = `${agentId}/${op}`;

    if (op === "llm") {
      const others = inspirations.filter((p) => p.id !== parent.id);
      const prompt = mutationPrompt(def, { code: parent.code, score: parent.score }, others.map((p) => ({ code: p.code, score: p.score })), def.best_known.score);
      try {
        let text: string;
        if (llmMode === "custom") text = await (opts.llm as LlmFn)(prompt);
        else if (lab!.mode === "mock") {
          await lab!.take(1);
          text = mockProgramBrain(prompt.user);
          lineage = `${agentId}/llm:mock`;
        } else {
          const res = await lab!.complete(agentId, { messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], temperature: 0.8, maxTokens: 2500 });
          text = res.text;
          lineage = `${agentId}/llm:${res.model}`;
        }
        llmCalls++;
        code = extractProgram(text);
        note = code ? "llm rewrite" : "llm reply had no usable program";
        if (!code) bandit.update("llm", false);
      } catch (e) {
        llmMode = "off";
        llmDisabledReason = e instanceof LabBudgetError ? `${e.scope}: ${e.message}` : `llm error: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      }
      if (!code) op = "tweak"; // fall back to a deterministic operator; the work slot is not wasted
    }
    if (op === "crossover") {
      const mates = [...elites.filter((e) => e.id !== parent.id && e.valid), ...inspirations.filter((p) => p.id !== parent.id && p.hash !== parent.hash)];
      if (mates.length) {
        second = mates[Math.floor(rng() * mates.length)];
        const x = crossover(parent.code, second.code, rng);
        if (x) ({ code, note } = x);
      }
      if (!code) {
        op = "tweak";
        second = null;
      }
    }
    if (op === "tweak" && !code) {
      const t = tweak(parent.code, rng);
      if (t) ({ code, note } = t);
      lineage = `${agentId}/tweak`;
    }
    if (!code) {
      result.children.push({ op, valid: false, score: null, parentScore: parent.score, improved: false, elite: false, error: "operator produced no program", constructMs: 0, verifyMs: 0 });
      continue;
    }
    // a duplicate costs no sandbox run: count it against the operator and retry with fresh tweaks
    for (let retry = 0; retry < 3 && code && (await programExists(env, def.id, island, await programHash(code))); retry++) {
      if (retry === 0) bandit.update(op, false);
      const t = tweak(retry === 0 ? parent.code : code, rng);
      op = "tweak";
      lineage = `${agentId}/tweak`;
      code = t?.code ?? null;
      note = t ? `${t.note} (after duplicate)` : note;
    }
    if (!code || (await programExists(env, def.id, island, await programHash(code)))) {
      result.children.push({ op, note, valid: false, score: null, parentScore: parent.score, improved: false, elite: false, duplicate: true, constructMs: 0, verifyMs: 0 });
      continue;
    }
    const ev = await evaluateProgram(def, code, { seed: evalSeed, ...fuel });
    result.evaluated++;
    const rep = await place(code, ev, { op, parent, second, lineage, note });
    bandit.update(op, rep.improved);
    result.children.push(rep);
  }

  // migration: ring topology, best elite of this island → next island
  const migrateEvery = Math.max(1, opts.migrateEvery ?? DISCOVERY_DEFAULTS.migrateEvery);
  if (islands > 1 && (gen + 1) % migrateEvery === 0) {
    const valid = elites.filter((e) => e.valid);
    if (valid.length) {
      const champ = valid.reduce((a, b) => (eliteBetter(def, b, a) ? b : a));
      const to = (island + 1) % islands;
      if (!(await programExists(env, def.id, to, champ.hash))) {
        const solution = champ.solution ? JSON.parse(champ.solution) : null;
        const ev: EvalResult = { valid: true, score: champ.score, solution, constructMs: 0, verifyMs: 0, fuelUsed: 0, verifierHash: problemRow.verifier_hash };
        const rep = await place(champ.code, ev, { op: "migration", parent: champ, lineage: champ.lineage ?? "migration", targetIsland: to });
        result.migrated = { from: island, to, programId: rep.id! };
      }
    }
  }

  await saveEvolutionState(env, def.id, gen + 1, bandit.toJSON());
  result.llmCalls = llmCalls;
  result.llmDisabledReason = llmDisabledReason;
  result.best = (best as RecordRow | null)?.score ?? null;
  return result;
}

/** Convenience for tests / owner tools: run `generations` steps back to back. */
export async function runGenerations(env: Env, lab: LabLLM | null, problemId: string, generations: number, opts: StepOptions = {}): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (let g = 0; g < generations; g++) out.push(await stepGeneration(env, lab, problemId, { ...opts, seed: `${opts.seed ?? 0}:${g}` }));
  return out;
}
