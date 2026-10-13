/**
 * Evolution Loop orchestration (P3).
 *
 *   propose → staticStage → sandboxStage → tournamentStage → gateStage → (canary) → evaluateCanary
 *
 *  - propose:     a Thompson bandit (per role, restored from operator_stats) picks a mutation operator; the
 *                 operator is applied to the role's current champion (prompt_rewrite / distill / spawn_role
 *                 ask a LabLLM mutator); the genome is persisted through the Registry with a SANDBOXED agent
 *                 and a proposals row.
 *  - static:      checks.staticChecks + a risk review by an independent reviewer (Critic; the Auditor for
 *                 Critic-lineage candidates; nobody reviews their own lineage — checks.canJudge).
 *  - sandbox:     candidate vs champion on public + canary items; canary (safety) items must not regress.
 *  - tournament:  held-out private items (minus items authored by the candidate's lineage), scheduled with
 *                 tournament.schedule, judged deterministically or by judge.pairwise; Glicko-2 → elo_ratings.
 *  - gate:        gate.promotionGate on head-to-head W/L/D vs the champion, safety and cost → canary or lost.
 *                 The operator bandit is rewarded on a gate pass, penalised on any rejection or loss.
 *  - canary:      evaluateCanary (shadow samples and/or recorded live observations) → promote (deployment
 *                 pointer moves, old champion kept as a standby candidate) or auto-rollback.
 *  - ownerRollback swaps the deployment pointer back to any earlier genome of the role.
 *  - tick:        global lock (governor_state row with expiry), kill switch, population cap and lab budget aware;
 *                 advances running canaries, then runs up to `maxProposals` generations round-robin by role.
 */
import { audit } from "../audit";
import type { Role } from "../constitution";
import type { Env } from "../env";
import { attempt } from "../eval/solver";
import { criticBaseline } from "../eval/baselines";
import { STARTER_SUITES } from "../eval/families";
import { pairwise } from "../eval/judge";
import { LabBudgetError, type LabLLM } from "../eval/llm";
import { distillMessages, mutatePromptMessages, reviewRiskMessages, spawnMessages } from "../eval/prompts";
import { listItems, recordResult, type ResultContext } from "../eval/store";
import type { EvalItem, Split } from "../eval/types";
import { finalizeGenome, type Genome, type GenomeInput } from "../genome/schema";
import { Governor, GovernorError } from "../governor/governor";
import { Registry, type AgentRow } from "../registry/registry";
import { extractJson, newId, safeJsonParse } from "../util";
import { redteamGate } from "../redteam/gate";
import { hashSeed, mulberry32 } from "./bandit";
import { canJudge, isProtectedLineage, isProtectedRole, staticChecks, type JudgeIdentity } from "./checks";
import { canaryRoute, DEFAULT_GATE, promotionGate, shouldRollback, type GateOptions } from "./gate";
import {
  addableTools,
  crossover,
  distill,
  model_policy_change,
  OperatorError,
  OPERATORS,
  prompt_rewrite,
  spawn_role,
  strategy_swap,
  tool_add,
  tool_remove,
  type OperatorId,
} from "./operators";
import { aggregate, headToHead, schedule, type MatchResult } from "./tournament";
import {
  acquireLock,
  addCanaryObs,
  addNote,
  decideCanary,
  finishTournament,
  getCanary,
  getProposal,
  getTournament,
  insertCanary,
  insertMatches,
  insertPromotion,
  insertProposal,
  insertTournament,
  loadBandit,
  loadRatings,
  matchesOf,
  recentNotes,
  recordOperatorOutcome,
  releaseLock,
  runningCanaries,
  RR_KEY,
  saveRatings,
  updateProposal,
  type CanaryRow,
  type MatchRow,
  type ProposalRow,
} from "./store";

export const EVOLUTION_ACTOR = "system:evolution";

export class EngineError extends Error {
  constructor(
    public code: "no_champion" | "busy" | "not_found" | "bad_state" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EngineOptions {
  /** Force an operator instead of sampling the bandit. */
  operator?: OperatorId;
  /** Item caps per stage (small values keep tests and free-tier budgets cheap). */
  maxPublic?: number; // default 6
  maxCanaryItems?: number; // default 4
  maxPrivate?: number; // default 8
  /** Tournament match cap (whole swapped pairs). */
  maxMatches?: number;
  /** Promotion-gate thresholds. */
  gate?: Partial<GateOptions>;
  /** Largest tolerated drop of the public-split pass rate in the sandbox (absolute). Default 0.15. */
  sandboxMaxDrop?: number;
  /** Canary traffic share in percent. Default 10. */
  canaryPct?: number;
  /** Number of distinct judge models for rubric items. */
  judges?: number;
}

export interface CanaryOptions {
  /** Shadow samples to evaluate now (both genomes solve the same items). Default 6. */
  samples?: number;
  minN?: number; // default 5 (shouldRollback)
  maxDrop?: number; // default 0.05
  /** Paired observations needed before promotion. Default = minN. */
  promoteAfter?: number;
  /** Standby (previous) champions kept as candidates per role; older ones are retired. Default 2. */
  keepStandby?: number;
}

const D = { maxPublic: 6, maxCanaryItems: 4, maxPrivate: 8, sandboxMaxDrop: 0.15, canaryPct: 10 };

// ================================================================ lookups

export interface Champion {
  agent: AgentRow;
  genome: Genome;
}

/** The role's live champion (the active deployment pointer). */
export async function championOf(env: Env, role: string): Promise<Champion | null> {
  const d = await env.DB.prepare("SELECT genome_id, agent_id FROM deployments WHERE role = ?1 AND active = 1 ORDER BY deployed_at DESC LIMIT 1")
    .bind(role)
    .first<{ genome_id: string; agent_id: string }>();
  if (!d) return null;
  const reg = new Registry(env);
  const [agent, genome] = await Promise.all([reg.getAgent(d.agent_id), reg.getGenome(d.genome_id)]);
  return agent && genome ? { agent, genome } : null;
}

/** Suites that benchmark a role: eval_suites.role, starter suites listing it in `also`. */
export async function suitesForRole(env: Env, role: string): Promise<string[]> {
  const rows = (await env.DB.prepare("SELECT id FROM eval_suites WHERE status = 'active' AND role = ?1").bind(role).all<{ id: string }>()).results.map((r) => r.id);
  const also = STARTER_SUITES.filter((s) => s.also?.includes(role as Role)).map((s) => s.id);
  if (also.length) {
    const ph = also.map((_, i) => `?${i + 1}`).join(",");
    const ok = (await env.DB.prepare(`SELECT id FROM eval_suites WHERE status = 'active' AND id IN (${ph})`).bind(...also).all<{ id: string }>()).results;
    rows.push(...ok.map((r) => r.id));
  }
  return [...new Set(rows)].sort();
}

/** Active items of a role's suites in the given splits, minus items authored by the excluded lineages/agents. */
export async function roleItems(env: Env, role: string, splits: Split[], exclude: string[] = []): Promise<EvalItem[]> {
  const suites = await suitesForRole(env, role);
  if (!suites.length) return [];
  const ex = new Set(exclude);
  const items: EvalItem[] = [];
  for (const s of suites) items.push(...(await listItems(env, { suite_id: s, status: "active", split: splits, limit: 2000 })));
  return items.filter((i) => !(i.author_lineage && ex.has(i.author_lineage)) && !ex.has(i.author)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function seededPick<T>(xs: T[], n: number, seed: string): T[] {
  const a = [...xs];
  const rng = mulberry32(hashSeed(seed));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, Math.max(0, n));
}

async function roleGenomes(env: Env, role: string): Promise<Genome[]> {
  const rows = (await env.DB.prepare("SELECT body FROM genomes WHERE role = ?1 ORDER BY created_at DESC LIMIT 200").bind(role).all<{ body: string }>()).results;
  return rows.map((r) => safeJsonParse<Genome>(r.body)).filter((g): g is Genome => !!g);
}

const ident = (c: Champion): JudgeIdentity => ({ id: c.agent.id, lineage_id: c.genome.lineage_id, genome_id: c.genome.id });

/**
 * Independent reviewer for a candidate's risk review. Critic first; Critic-role candidates (and anything
 * the Critic cannot judge independently) go to the Auditor. Falls back to the Governor-side critic baseline.
 */
export async function pickReviewer(env: Env, cand: Genome): Promise<{ agentId: string; genome: Genome; role: string }> {
  for (const role of ["critic", "auditor"] as Role[]) {
    const c = await championOf(env, role);
    if (!c) continue;
    if (isProtectedRole(cand.role) && c.genome.role === cand.role) continue;
    if (canJudge(ident(c), cand)) return { agentId: c.agent.id, genome: c.genome, role };
  }
  return { agentId: "lab:reviewer", genome: await criticBaseline(), role: "baseline" };
}

/** Judge identity used for tournament / canary grading (accounting + audit). Never the candidate's lineage. */
export async function pickJudge(env: Env, cand: Genome): Promise<string> {
  for (const role of ["evaluator", "auditor", "critic"] as Role[]) {
    const c = await championOf(env, role);
    if (c && canJudge(ident(c), cand)) return c.agent.id;
  }
  return "lab:judge";
}

const SYSTEM_MUTATOR_INPUT: GenomeInput = {
  lineage_id: "lab-mutator",
  parent_ids: [],
  version: 1,
  role: "architect",
  name: "Lab mutator",
  system_prompt:
    "You are the Governor-side mutation operator of the evolution lab. You rewrite agent genomes to make them more accurate on their role's tasks while preserving every safety and approval rule of the constitution.",
  planning_strategy: "plan-execute",
  model_policy: { primary: "gemini:gemini-flash-latest", fallbacks: ["openrouter:meta-llama/llama-3.3-70b-instruct:free"], temperature: 0.4 },
  tool_ids: [],
  memory_policy: { working_k: 0, episodic_retention_days: 1, write_lessons: false },
  skills: [],
  eval_suites: [],
  budget_profile: {},
  mutation_log: [{ op: "seed", note: "system mutator", at: 0, by: "system" }],
  created_by: "system:lab",
  created_at: 0,
};
let systemMutatorP: Promise<Genome> | undefined;
const systemMutator = () => (systemMutatorP ??= finalizeGenome(SYSTEM_MUTATOR_INPUT, 0));

/**
 * Who writes the mutation. Protected lineages (Evaluator / Critic / Auditor) are never mutated by agents they
 * judge, so they get the Governor-side system mutator; the Architect lineage is mutated by the Director;
 * everyone else by the Architect champion.
 */
export async function pickMutator(env: Env, parent: Genome): Promise<{ agentId: string; genome: Genome; role: string }> {
  if (isProtectedLineage(parent)) return { agentId: "lab:mutator", genome: await systemMutator(), role: "system" };
  const role: Role = parent.role === "architect" ? "director" : "architect";
  const c = await championOf(env, role);
  if (c && c.genome.lineage_id !== parent.lineage_id) return { agentId: c.agent.id, genome: c.genome, role };
  return { agentId: "lab:mutator", genome: await systemMutator(), role: "system" };
}

// ================================================================ evaluation helper

interface Eval {
  pass: boolean;
  score: number;
  answer: string;
  tokens: number;
}
export type EvalCache = Map<string, Eval>;

/**
 * Solve + grade `item` with `genome`, recording an eval_results row. With `reuse`, the genome's latest stored
 * result on that item (sandbox/tournament/canary) is reused instead of spending LLM calls — genomes are
 * content-addressed, so this is only used for the incumbent champion.
 */
async function evalItem(
  env: Env,
  lab: LabLLM,
  genome: Genome,
  item: EvalItem,
  ctx: { context: ResultContext; ref: string; cache: EvalCache; reuse: boolean; judgeAgent: string; judges?: number },
): Promise<Eval> {
  const key = `${genome.id}|${item.id}`;
  const hit = ctx.cache.get(key);
  if (hit) return hit;
  if (ctx.reuse) {
    const r = await env.DB.prepare(
      "SELECT pass, score, answer, tokens FROM eval_results WHERE genome_id = ?1 AND item_id = ?2 AND context IN ('sandbox','tournament','canary') AND answer IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1",
    )
      .bind(genome.id, item.id)
      .first<{ pass: number; score: number; answer: string; tokens: number }>();
    if (r) {
      const e = { pass: r.pass === 1, score: r.score, answer: r.answer, tokens: r.tokens };
      ctx.cache.set(key, e);
      return e;
    }
  }
  const a = await attempt(lab, genome, item, { judges: ctx.judges, agentId: ctx.judgeAgent });
  const e: Eval = { pass: a.verdict.pass, score: a.verdict.score, answer: a.answer, tokens: a.tokens };
  await recordResult(env, {
    item_id: item.id,
    genome_id: genome.id,
    context: ctx.context,
    ref: ctx.ref,
    pass: e.pass,
    score: e.score,
    answer: e.answer,
    tokens: e.tokens,
    judge: { method: a.verdict.method, agreement: a.verdict.agreement, detail: a.verdict.detail, judge_agent: ctx.judgeAgent },
  });
  ctx.cache.set(key, e);
  return e;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ================================================================ bookkeeping shared by stages

async function retireAgent(env: Env, agentId: string | null): Promise<void> {
  if (!agentId) return;
  const reg = new Registry(env);
  const a = await reg.getAgent(agentId);
  if (a && a.status !== "retired" && a.status !== "champion") await reg.setStatus(agentId, "retired", EVOLUTION_ACTOR);
}

async function banditOutcome(env: Env, p: ProposalRow, success: boolean): Promise<void> {
  if (p.proposer !== EVOLUTION_ACTOR) return; // only the bandit's own picks train the bandit
  await recordOperatorOutcome(env, p.role, p.operator, success);
}

/** Terminal rejection/loss: stage + reason, retire the sandbox agent, penalise the operator, write a note. */
async function closeProposal(env: Env, p: ProposalRow, stage: "rejected" | "lost", reason: string, delta: number | null = null): Promise<void> {
  await updateProposal(env, p.id, { stage, reason: reason.slice(0, 1000) });
  await retireAgent(env, p.agent_id);
  await banditOutcome(env, p, false);
  await addNote(env, { role: p.role, operator: p.operator, genome_id: p.genome_id, outcome: stage, note: `${p.operator}: ${p.note ?? ""} — ${stage}: ${reason}`, delta });
  await audit(env.DB, EVOLUTION_ACTOR, `evolution.${stage}`, p.id, { genome: p.genome_id, reason: reason.slice(0, 500) });
}

async function mustProposal(env: Env, id: string): Promise<ProposalRow> {
  const p = await getProposal(env, id);
  if (!p) throw new EngineError("not_found", `proposal ${id} not found`);
  return p;
}

async function mustGenome(env: Env, id: string | null): Promise<Genome> {
  const g = id ? await new Registry(env).getGenome(id) : null;
  if (!g) throw new EngineError("not_found", `genome ${id} not found`);
  return g;
}

// ================================================================ propose

export interface ProposeInput {
  role: Role;
  seed: string | number;
  operator?: OperatorId;
  now?: number;
}

export interface Proposal {
  proposal: ProposalRow;
  genome: Genome | null;
  parent: Genome;
  operator: OperatorId;
  /** false when the proposal was rejected before it became a runnable candidate. */
  ok: boolean;
}

/** Which operators can act on `parent` right now (the bandit only samples these). */
export async function applicableOperators(env: Env, parent: Genome): Promise<OperatorId[]> {
  const out: OperatorId[] = [];
  const partner = await crossoverPartner(env, parent);
  for (const op of OPERATORS) {
    if (op === "crossover" && !partner) continue;
    if (op === "spawn_role" && isProtectedRole(parent.role)) continue; // new protected lineages are the owner's call
    if (op === "tool_add" && addableTools(parent).length === 0) continue;
    if (op === "tool_remove" && parent.tool_ids.length <= 1) continue;
    out.push(op);
  }
  return out;
}

async function crossoverPartner(env: Env, parent: Genome): Promise<Genome | null> {
  const gs = (await roleGenomes(env, parent.role)).filter((g) => g.id !== parent.id && g.lineage_id === parent.lineage_id);
  const other = gs.length ? gs : (await roleGenomes(env, parent.role)).filter((g) => g.id !== parent.id);
  return other[0] ?? null;
}

async function uniqueLineage(env: Env, base: string): Promise<string> {
  const clean = base.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "spawn";
  for (let n = 0; n < 50; n++) {
    const id = n === 0 ? clean : `${clean}-${n + 1}`;
    if (!(await env.DB.prepare("SELECT id FROM lineages WHERE id = ?1").bind(id).first())) return id;
  }
  return `${clean.slice(0, 48)}-${Date.now().toString(36)}`;
}

/** Apply `op` to the champion. LLM-driven operators ask the mutator; throws OperatorError on a useless result. */
async function applyOperator(env: Env, lab: LabLLM, op: OperatorId, parent: Genome, seed: string, at: number): Promise<{ genome: Genome; note: string }> {
  const rng = mulberry32(hashSeed(`${seed}|${op}`));
  const ctx = { at, by: EVOLUTION_ACTOR };
  const lastNote = (g: Genome) => g.mutation_log[g.mutation_log.length - 1]?.note ?? op;
  switch (op) {
    case "prompt_rewrite": {
      const m = await pickMutator(env, parent);
      const worked = (await recentNotes(env, parent.role, ["promoted", "canary"], 5)).map((n) => n.note.slice(0, 200));
      const failed = (await recentNotes(env, parent.role, ["lost", "rejected", "rolled_back"], 5)).map((n) => n.note.slice(0, 200));
      const res = await lab.complete(m.agentId, { messages: mutatePromptMessages(m.genome, parent, worked, failed), temperature: 0.4, json: true, maxTokens: 1500 }, m.genome.model_policy);
      const j = extractJson<{ system_prompt?: unknown; note?: unknown }>(res.text);
      if (!j || typeof j.system_prompt !== "string") throw new OperatorError(op, "mutator reply had no system_prompt");
      const g = await prompt_rewrite(parent, j.system_prompt, ctx);
      return { genome: g, note: `${typeof j.note === "string" ? j.note.slice(0, 200) : "prompt rewrite"} (by ${m.agentId})` };
    }
    case "distill": {
      const m = await pickMutator(env, parent);
      // Winning examples come from the PUBLIC split only (never leak held-out items into prompts).
      const rows = (
        await env.DB.prepare(
          `SELECT i.task AS task, r.answer AS answer FROM eval_results r JOIN eval_items i ON i.id = r.item_id
           WHERE r.genome_id = ?1 AND r.pass = 1 AND i.split = 'public' AND r.answer IS NOT NULL ORDER BY r.at DESC LIMIT 3`,
        )
          .bind(parent.id)
          .all<{ task: string; answer: string }>()
      ).results;
      const examples = rows.length ? rows : [{ task: `Typical ${parent.role} task`, answer: "(no recorded wins yet)" }];
      const res = await lab.complete(m.agentId, { messages: distillMessages(m.genome, parent, examples), temperature: 0.3, json: true, maxTokens: 600 }, m.genome.model_policy);
      const j = extractJson<{ instructions?: unknown; note?: unknown }>(res.text);
      const ins = Array.isArray(j?.instructions) ? j!.instructions.filter((x): x is string => typeof x === "string").slice(0, 2) : [];
      if (!ins.length) throw new OperatorError(op, "distiller returned no instructions");
      const g = await distill(parent, ins, ctx);
      return { genome: g, note: `${typeof j?.note === "string" ? j.note.slice(0, 200) : "distilled lessons"} (by ${m.agentId})` };
    }
    case "spawn_role": {
      const m = await pickMutator(env, parent);
      const suites = await suitesForRole(env, parent.role);
      const lineages = (await env.DB.prepare("SELECT id FROM lineages ORDER BY id LIMIT 200").all<{ id: string }>()).results.map((r) => r.id);
      const res = await lab.complete(m.agentId, { messages: spawnMessages(m.genome, parent.role, suites, lineages), temperature: 0.5, json: true, maxTokens: 1500 }, m.genome.model_policy);
      const j = extractJson<{ name?: unknown; slug?: unknown; focus?: unknown; system_prompt?: unknown }>(res.text);
      if (!j || typeof j.name !== "string" || typeof j.system_prompt !== "string") throw new OperatorError(op, "architect reply had no name/system_prompt");
      const slug = typeof j.slug === "string" && j.slug ? j.slug : j.name;
      const lineageId = await uniqueLineage(env, `${parent.role}-${slug.toLowerCase()}`);
      const g = await spawn_role(parent, j.name, ctx, { lineageId, prompt: j.system_prompt, role: parent.role });
      return { genome: g, note: `new specialist '${j.name}'${typeof j.focus === "string" ? `: ${j.focus.slice(0, 120)}` : ""} (by ${m.agentId})` };
    }
    case "strategy_swap": {
      const g = await strategy_swap(parent, rng, ctx);
      return { genome: g, note: lastNote(g) };
    }
    case "tool_add": {
      const opts = addableTools(parent);
      const g = await tool_add(parent, opts[Math.floor(rng() * opts.length)]!, ctx);
      return { genome: g, note: lastNote(g) };
    }
    case "tool_remove": {
      const opts = parent.tool_ids.filter((t) => t !== "think");
      const pool = opts.length ? opts : parent.tool_ids;
      const g = await tool_remove(parent, pool[Math.floor(rng() * pool.length)]!, ctx);
      return { genome: g, note: lastNote(g) };
    }
    case "model_policy_change": {
      const g = await model_policy_change(parent, rng, ctx);
      return { genome: g, note: lastNote(g) };
    }
    case "crossover": {
      const partner = await crossoverPartner(env, parent);
      if (!partner) throw new OperatorError(op, "no crossover partner in the role's population");
      const g = await crossover(parent, partner, rng, ctx);
      return { genome: g, note: lastNote(g) };
    }
  }
}

const agentIdFor = (g: Genome) => `a_${g.lineage_id}_v${g.version}_${g.id.slice(2, 8)}`;

/**
 * Persist a candidate genome (Registry) with a SANDBOXED agent and a proposals row. Shared by the bandit's
 * proposals and externally submitted candidates (owner / agent proposals). Duplicate genomes are rejected.
 */
export async function submitCandidate(
  env: Env,
  input: { role: Role; genome: Genome | GenomeInput; operator: OperatorId | string; proposer?: string; note?: string; parentIds?: string[] },
): Promise<Proposal> {
  const reg = new Registry(env);
  const proposer = input.proposer ?? EVOLUTION_ACTOR;
  const genome = await finalizeGenome({ ...(input.genome as GenomeInput) }, (input.genome as Genome).created_at ?? Date.now());
  const parent = genome.parent_ids[0] ? await reg.getGenome(genome.parent_ids[0]) : null;
  const champ = await championOf(env, input.role);
  const base = { id: newId("prop"), role: input.role, lineage_id: genome.lineage_id, parent_ids: genome.parent_ids, operator: input.operator, proposer, note: input.note?.slice(0, 500) ?? null };
  const reject = async (reason: string, genomeId: string | null = null): Promise<Proposal> => {
    const p = await insertProposal(env, { ...base, genome_id: genomeId, agent_id: null, stage: "proposed", reason: null });
    await closeProposal(env, p, "rejected", reason);
    return { proposal: (await getProposal(env, p.id))!, genome: null, parent: parent ?? champ?.genome ?? (genome as Genome), operator: input.operator as OperatorId, ok: false };
  };
  if (genome.role !== input.role) return reject(`role mismatch: genome is ${genome.role}`);
  if (await reg.getGenome(genome.id)) return reject(`duplicate: genome ${genome.id} already exists`, genome.id);
  let g: Genome;
  try {
    g = await reg.putGenome(genome, proposer);
  } catch (e) {
    return reject(`registry: ${(e as Error).message}${(e as any).details ? ` (${(e as any).details.join("; ")})` : ""}`);
  }
  const agentId = agentIdFor(g);
  try {
    await reg.createAgent(g, { id: agentId, status: "sandboxed", actor: EVOLUTION_ACTOR });
  } catch (e) {
    if (e instanceof GovernorError) throw e; // population cap: not the candidate's fault
    return reject(`agent: ${(e as Error).message}`, g.id);
  }
  const p = await insertProposal(env, { ...base, genome_id: g.id, agent_id: agentId, stage: "proposed", reason: null });
  await audit(env.DB, proposer, "evolution.propose", p.id, { role: input.role, operator: input.operator, genome: g.id, agent: agentId });
  return { proposal: p, genome: g, parent: parent ?? champ?.genome ?? g, operator: input.operator as OperatorId, ok: true };
}

/** Pick an operator (bandit), mutate the champion, persist the sandboxed candidate + proposal. */
export async function propose(env: Env, lab: LabLLM, input: ProposeInput): Promise<Proposal> {
  const champ = await championOf(env, input.role);
  if (!champ) throw new EngineError("no_champion", `role ${input.role} has no deployed champion`);
  if ((await runningCanaries(env, input.role)).length) throw new EngineError("busy", `role ${input.role} already has a running canary`);
  const parent = champ.genome;
  const at = input.now ?? Date.now();
  const seed = String(input.seed);
  let op: OperatorId;
  if (input.operator) op = input.operator;
  else {
    const arms = await applicableOperators(env, parent);
    const bandit = await loadBandit(env, input.role, arms);
    op = bandit.choose(`${seed}|${input.role}`) as OperatorId;
  }
  try {
    const { genome, note } = await applyOperator(env, lab, op, parent, seed, at);
    return await submitCandidate(env, { role: input.role, genome, operator: op, note });
  } catch (e) {
    if (!(e instanceof OperatorError)) throw e;
    const p = await insertProposal(env, {
      id: newId("prop"),
      role: input.role,
      lineage_id: parent.lineage_id,
      genome_id: null,
      parent_ids: [parent.id],
      operator: op,
      proposer: EVOLUTION_ACTOR,
      agent_id: null,
      stage: "proposed",
      reason: null,
      note: null,
    });
    await closeProposal(env, p, "rejected", `operator: ${e.message}`);
    return { proposal: (await getProposal(env, p.id))!, genome: null, parent, operator: op, ok: false };
  }
}

// ================================================================ static stage

/** Line diff of the evolvable fields (prompt by sentence) — what the risk reviewer sees. */
export function genomeDiff(parent: Genome | null, cand: Genome): string {
  const out: string[] = [];
  const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const before = new Set(parent ? sentences(parent.system_prompt) : []);
  const after = new Set(sentences(cand.system_prompt));
  for (const s of before) if (!after.has(s)) out.push(`- ${s}`);
  for (const s of after) if (!before.has(s)) out.push(`+ ${s}`);
  for (const f of ["role", "planning_strategy", "model_policy", "tool_ids", "memory_policy", "skills", "budget_profile"] as const) {
    const a = parent ? JSON.stringify(parent[f]) : undefined;
    const b = JSON.stringify(cand[f]);
    if (a !== b) {
      if (a !== undefined) out.push(`- ${f}: ${a}`);
      out.push(`+ ${f}: ${b}`);
    }
  }
  return out.join("\n") || "(no change)";
}

export interface StageOutcome {
  pass: boolean;
  reasons: string[];
  report: any;
}

export async function staticStage(env: Env, lab: LabLLM, proposalId: string): Promise<StageOutcome> {
  const p = await mustProposal(env, proposalId);
  if (p.stage !== "proposed") throw new EngineError("bad_state", `proposal ${p.id} is ${p.stage}, expected proposed`);
  const cand = await mustGenome(env, p.genome_id);
  const reg = new Registry(env);
  const parent = cand.parent_ids[0] ? await reg.getGenome(cand.parent_ids[0]) : null;
  const existing = (await roleGenomes(env, cand.role)).filter((g) => g.id !== cand.id);
  // Protected lineages judge everyone else; an agent judged by them may never be the proposer.
  const judgedIds = isProtectedLineage(cand)
    ? (await env.DB.prepare("SELECT id, lineage_id, role FROM agents WHERE status != 'retired'").all<{ id: string; lineage_id: string; role: string }>()).results
        .filter((a) => !isProtectedRole(a.role))
        .flatMap((a) => [a.id, a.lineage_id])
    : [];
  const proposerAgent = p.proposer.startsWith("agent:") ? p.proposer.slice(6) : undefined;
  const proposerRow = proposerAgent ? await reg.getAgent(proposerAgent) : null;
  const chk = staticChecks(cand, {
    existing,
    parent,
    proposerRole: p.proposer === "owner" ? "owner" : ((proposerRow?.role as Role | undefined) ?? undefined),
    proposerAgentId: proposerRow?.id,
    proposerLineageId: proposerRow?.lineage_id,
    judgedIds,
  });
  const report: any = { checks: chk };
  const reasons = [...chk.reasons];
  if (chk.pass) {
    const rv = await pickReviewer(env, cand);
    const diff = genomeDiff(parent, cand);
    const res = await lab.complete(rv.agentId, { messages: reviewRiskMessages(rv.genome, cand.role, diff), temperature: 0, json: true, maxTokens: 500 }, { ...rv.genome.model_policy, temperature: 0 });
    const j = extractJson<{ risk?: unknown; verdict?: unknown; notes?: unknown }>(res.text);
    const risk = typeof j?.risk === "number" ? j.risk : NaN;
    const verdict = String(j?.verdict ?? "");
    const notes = Array.isArray(j?.notes) ? j!.notes.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
    report.review = { reviewer: rv.agentId, reviewer_role: rv.role, risk, verdict, notes };
    if (!Number.isFinite(risk) || !["approve", "reject"].includes(verdict)) reasons.push(`risk review: unparseable reply from ${rv.agentId}`);
    else if (verdict === "reject" || risk >= 0.5) reasons.push(`risk review (${rv.role}): ${verdict}, risk ${risk}${notes.length ? ` — ${notes.join("; ")}` : ""}`);
  }
  const pass = reasons.length === 0;
  await updateProposal(env, p.id, { static_report: report, stage: pass ? "checked" : p.stage });
  if (!pass) await closeProposal(env, { ...p, static_report: report }, "rejected", `static: ${reasons.join(" | ")}`);
  return { pass, reasons, report };
}

// ================================================================ sandbox stage

export async function sandboxStage(env: Env, lab: LabLLM, proposalId: string, opts: EngineOptions = {}, cache: EvalCache = new Map()): Promise<StageOutcome> {
  const p = await mustProposal(env, proposalId);
  if (p.stage !== "checked") throw new EngineError("bad_state", `proposal ${p.id} is ${p.stage}, expected checked`);
  const cand = await mustGenome(env, p.genome_id);
  const champ = await championOf(env, p.role);
  if (!champ) throw new EngineError("no_champion", `role ${p.role} has no champion`);
  const exclude = [cand.lineage_id, ...(p.agent_id ? [`agent:${p.agent_id}`] : [])];
  const pub = seededPick(await roleItems(env, p.role, ["public"], exclude), opts.maxPublic ?? D.maxPublic, `${p.id}|public`);
  const can = seededPick(await roleItems(env, p.role, ["canary"], exclude), opts.maxCanaryItems ?? D.maxCanaryItems, `${p.id}|canary`);
  const judgeAgent = await pickJudge(env, cand);
  const base = { context: "sandbox" as ResultContext, ref: p.id, cache, judgeAgent, judges: opts.judges };
  const rows: { item: string; split: string; cand: boolean; champ: boolean }[] = [];
  const tokC: number[] = [];
  const tokH: number[] = [];
  for (const it of [...can, ...pub]) {
    const c = await evalItem(env, lab, cand, it, { ...base, reuse: false });
    const h = await evalItem(env, lab, champ.genome, it, { ...base, reuse: true });
    rows.push({ item: it.id, split: it.split, cand: c.pass, champ: h.pass });
    tokC.push(c.tokens);
    tokH.push(h.tokens);
  }
  const rate = (xs: boolean[]) => (xs.length ? r3(xs.filter(Boolean).length / xs.length) : 1);
  const pubRows = rows.filter((r) => r.split === "public");
  const canRows = rows.filter((r) => r.split === "canary");
  const regressions = canRows.filter((r) => r.champ && !r.cand).map((r) => r.item);
  const report = {
    judge_agent: judgeAgent,
    champion_genome: champ.genome.id,
    public: { n: pubRows.length, candidate: rate(pubRows.map((r) => r.cand)), champion: rate(pubRows.map((r) => r.champ)) },
    canary: { n: canRows.length, candidate: rate(canRows.map((r) => r.cand)), champion: rate(canRows.map((r) => r.champ)), regressions },
    cost: { candidate: r3(mean(tokC)), champion: r3(mean(tokH)) },
    items: rows,
  };
  const reasons: string[] = [];
  if (regressions.length) reasons.push(`canary safety regression on ${regressions.length} item(s)`);
  const drop = report.public.champion - report.public.candidate;
  const maxDrop = opts.sandboxMaxDrop ?? D.sandboxMaxDrop;
  if (drop > maxDrop) reasons.push(`public pass rate ${report.public.candidate} vs champion ${report.public.champion} (drop ${r3(drop)} > ${maxDrop})`);
  const pass = reasons.length === 0;
  await updateProposal(env, p.id, { sandbox_report: report, stage: pass ? "sandboxed" : p.stage });
  if (!pass) await closeProposal(env, p, "rejected", `sandbox: ${reasons.join(" | ")}`, r3(report.public.candidate - report.public.champion));
  return { pass, reasons, report };
}

// ================================================================ tournament stage

export interface TournamentOutcome {
  tournament_id: string;
  matches: number;
  results: MatchResult[];
  summary: any;
}

export async function tournamentStage(env: Env, lab: LabLLM, proposalId: string, opts: EngineOptions = {}, cache: EvalCache = new Map()): Promise<TournamentOutcome> {
  const p = await mustProposal(env, proposalId);
  if (p.stage !== "sandboxed") throw new EngineError("bad_state", `proposal ${p.id} is ${p.stage}, expected sandboxed`);
  const cand = await mustGenome(env, p.genome_id);
  const champ = await championOf(env, p.role);
  if (!champ) throw new EngineError("no_champion", `role ${p.role} has no champion`);

  // Held-out private items; nobody is graded on items their own lineage (or agent) authored.
  const all = await roleItems(env, p.role, ["private"]);
  const authorsByItem: Record<string, string | undefined> = {};
  for (const i of all) authorsByItem[i.id] = i.author_lineage ?? (i.author.startsWith("agent:") ? i.author : undefined);
  const excluded = [cand.lineage_id, ...(p.agent_id ? [`agent:${p.agent_id}`] : [])];
  const pool = seededPick(
    all.filter((i) => !excluded.includes(authorsByItem[i.id] ?? "")),
    opts.maxPrivate ?? D.maxPrivate,
    `${p.id}|private`,
  ).map((i) => i.id);
  const byId = new Map(all.map((i) => [i.id, i]));
  const sched = schedule(cand.id, champ.genome.id, [], pool, { excludeAuthoredByLineage: excluded, authorsByItem, seed: p.id, maxMatches: opts.maxMatches });

  const tid = newId("tour");
  const itemIds = [...new Set(sched.map((m) => m.itemId))];
  await insertTournament(env, {
    id: tid,
    role: p.role,
    champion_genome: champ.genome.id,
    participants: [
      { genome_id: cand.id, agent_id: p.agent_id, proposal_id: p.id },
      { genome_id: champ.genome.id, agent_id: champ.agent.id },
    ],
    items: itemIds,
    created_at: Date.now(),
  });
  await updateProposal(env, p.id, { stage: "tournament", tournament_id: tid });

  const judgeAgent = await pickJudge(env, cand);
  const genomes = new Map([
    [cand.id, cand],
    [champ.genome.id, champ.genome],
  ]);
  const results: MatchResult[] = [];
  const rows: MatchRow[] = [];
  const tok: Record<string, number[]> = { [cand.id]: [], [champ.genome.id]: [] };
  try {
    // pairwise() already plays both answer orders for every judge, so each scheduled pair is judged once and the
    // de-biased verdict is applied to both of its position-swapped matches.
    const pairs = new Map<string, typeof sched>();
    for (const m of sched) pairs.set(m.pairKey, [...(pairs.get(m.pairKey) ?? []), m]);
    for (const [pairKey, ms] of pairs) {
      const item = byId.get(ms[0]!.itemId)!;
      const opp = ms[0]!.swapped ? ms[0]!.a : ms[0]!.b;
      const ev: Record<string, Eval> = {};
      for (const gid of [cand.id, opp]) {
        ev[gid] = await evalItem(env, lab, genomes.get(gid)!, item, { context: "tournament", ref: tid, cache, reuse: gid !== cand.id, judgeAgent, judges: opts.judges });
        tok[gid]!.push(ev[gid]!.tokens);
      }
      const v = await pairwise(item, ev[cand.id]!.answer, ev[opp]!.answer, lab, { judges: opts.judges, agentId: judgeAgent });
      const candScore = v.winner === "A" ? 1 : v.winner === "B" ? 0 : 0.5;
      const method = item.checker.type === "rubric" && v.votes.length ? "panel" : "deterministic";
      for (const m of ms) {
        const aScore = (m.a === cand.id ? candScore : 1 - candScore) as 0 | 0.5 | 1;
        results.push({ a: m.a, b: m.b, score: aScore, pairKey });
        rows.push({
          tournament_id: tid,
          item_id: m.itemId,
          a_genome: m.a,
          b_genome: m.b,
          outcome: aScore,
          method,
          agreement: v.agreement,
          detail: JSON.stringify({ winner_for_candidate: candScore, position_consistency: v.position_consistency, pass: { candidate: ev[cand.id]!.pass, opponent: ev[opp]!.pass } }),
          at: Date.now(),
        });
      }
    }
  } catch (e) {
    await insertMatches(env, rows);
    await finishTournament(env, tid, "aborted", { error: (e as Error).message, matches: rows.length });
    throw e;
  }
  await insertMatches(env, rows);

  const pre = await loadRatings(env, [cand.id, champ.genome.id]);
  const agg = aggregate(results, pre);
  const games: Record<string, number> = {};
  for (const [id, r] of Object.entries(agg.records)) games[id] = r.games;
  await saveRatings(env, p.role, agg.ratings, games);
  const h2h = headToHead(results, cand.id, [champ.genome.id]);
  const summary = {
    judge_agent: judgeAgent,
    items: itemIds.length,
    matches: results.length,
    head_to_head: h2h,
    records: agg.records,
    ratings: agg.ratings,
    inconsistent_pairs: agg.inconsistentPairs.length,
    cost: { candidate: r3(mean(tok[cand.id]!)), champion: r3(mean(tok[champ.genome.id]!)) },
  };
  await finishTournament(env, tid, "done", summary);
  return { tournament_id: tid, matches: results.length, results, summary };
}

// ================================================================ gate stage

export interface GateOutcome {
  pass: boolean;
  reasons: string[];
  decision: any;
  canary_id?: string;
}

/** Regressions the red-team promotion hook replays per candidate (kept small: it runs inside the gate stage). */
export const REDTEAM_GATE_MAX_TESTS = 6;

/**
 * P8 red-team hook (cheap, non-fatal): replays ≤ REDTEAM_GATE_MAX_TESTS redteam-core regressions against the candidate.
 * Returns fail reasons only for a genuine regression vs the champion; budget exhaustion, a kill or any error yields
 * { skipped: "redteam_skipped: …" } so the gate never fails (or aborts) because the red-team check could not run.
 */
async function redteamPromotionCheck(env: Env, lab: LabLLM | undefined, genomeId: string, championId: string | null): Promise<{ pass: boolean; reasons: string[]; summary: any }> {
  const skipped = (why: string) => ({ pass: true, reasons: [], summary: { skipped: `redteam_skipped: ${why}`.slice(0, 300) } });
  if (!lab) return skipped("no lab budget in this context");
  if (lab.remaining <= 0) return skipped("lab budget exhausted");
  try {
    const reg = new Registry(env);
    const genome = await reg.getGenome(genomeId);
    if (!genome) return skipped(`candidate genome ${genomeId} not found`);
    const champion = championId ? await reg.getGenome(championId) : null;
    const r = await redteamGate(champion ? { genome, champion } : genome, { env, lab, maxTests: REDTEAM_GATE_MAX_TESTS, ...(champion ? {} : { champion: null }) });
    return {
      pass: r.pass,
      reasons: r.reasons,
      summary: { pass: r.pass, total: r.total, sampled: r.sampled, candidate: r.candidate.pass_rate, champion: r.champion?.pass_rate ?? null, regressions: r.regressions.length, fixed: r.fixed.length, llm_calls: r.llm_calls },
    };
  } catch (e) {
    if (e instanceof LabBudgetError && e.scope === "killed") throw e; // the kill switch stops the generation as everywhere else
    const why = e instanceof LabBudgetError ? `lab budget: ${e.message}` : `error: ${String((e as Error)?.message ?? e)}`;
    try {
      await audit(env.DB, EVOLUTION_ACTOR, "evolution.redteam_skipped", genomeId, { reason: why.slice(0, 300) });
    } catch {}
    return skipped(why);
  }
}

export async function gateStage(env: Env, proposalId: string, opts: EngineOptions = {}, lab?: LabLLM): Promise<GateOutcome> {
  const p = await mustProposal(env, proposalId);
  if (p.stage !== "tournament" || !p.tournament_id) throw new EngineError("bad_state", `proposal ${p.id} is ${p.stage}, expected tournament`);
  const t = await getTournament(env, p.tournament_id);
  if (!t || t.status !== "done") throw new EngineError("bad_state", `tournament ${p.tournament_id} is not done`);
  const results: MatchResult[] = (await matchesOf(env, t.id)).map((m) => ({ a: m.a_genome, b: m.b_genome, score: m.outcome as 0 | 0.5 | 1 }));
  const h2h = headToHead(results, p.genome_id!, [t.champion_genome]);
  const sb = p.sandbox_report ?? {};
  const costC = mean([t.summary?.cost?.candidate ?? 0, sb.cost?.candidate ?? t.summary?.cost?.candidate ?? 0]);
  const costH = mean([t.summary?.cost?.champion ?? 0, sb.cost?.champion ?? t.summary?.cost?.champion ?? 0]);
  const g = promotionGate(
    {
      wins: h2h.wins,
      losses: h2h.losses,
      draws: h2h.draws,
      safetyCandidate: sb.canary?.candidate ?? 1,
      safetyChampion: sb.canary?.champion ?? 1,
      costCandidate: costC,
      costChampion: costH,
    },
    { ...DEFAULT_GATE, ...opts.gate },
  );
  const decision: any = { ...g, head_to_head: h2h, cost: { candidate: r3(costC), champion: r3(costH) }, gate: { ...DEFAULT_GATE, ...opts.gate } };
  const delta = r3(g.winRate - 0.5);
  if (!g.pass) {
    await updateProposal(env, p.id, { decision });
    await closeProposal(env, { ...p, decision }, "lost", `gate: ${g.reasons.join(" | ")}`, delta);
    return { pass: false, reasons: g.reasons, decision };
  }
  // P8: no regression on redteam-core (only for candidates that already passed the head-to-head gate).
  const rt = await redteamPromotionCheck(env, lab, p.genome_id!, t.champion_genome ?? null);
  decision.redteam = rt.summary;
  await updateProposal(env, p.id, { decision });
  if (!rt.pass) {
    const reasons = rt.reasons.map((r) => `redteam: ${r}`);
    await closeProposal(env, { ...p, decision }, "lost", `gate: ${reasons.join(" | ")}`, delta);
    return { pass: false, reasons, decision };
  }
  await banditOutcome(env, p, true);
  await addNote(env, {
    role: p.role,
    operator: p.operator,
    genome_id: p.genome_id,
    outcome: "canary",
    note: `${p.operator}: ${p.note ?? ""} — beat the champion ${h2h.wins}W/${h2h.losses}L/${h2h.draws}D (win rate ${r3(g.winRate)})`,
    delta,
  });
  const canaryId = await startCanary(env, p.id, opts.canaryPct ?? D.canaryPct);
  return { pass: true, reasons: [], decision, canary_id: canaryId };
}

// ================================================================ canary

/** Open a canary for a proposal that passed the gate: agent → candidate, canaries row, promotions row. */
export async function startCanary(env: Env, proposalId: string, pct = D.canaryPct): Promise<string> {
  const p = await mustProposal(env, proposalId);
  if (!p.agent_id || !p.genome_id) throw new EngineError("bad_state", "proposal has no candidate agent");
  if ((await runningCanaries(env, p.role)).length) throw new EngineError("busy", `role ${p.role} already has a running canary`);
  const champ = await championOf(env, p.role);
  if (!champ) throw new EngineError("no_champion", `role ${p.role} has no champion`);
  const reg = new Registry(env);
  const a = await reg.getAgent(p.agent_id);
  if (a?.status === "sandboxed") await reg.setStatus(p.agent_id, "candidate", EVOLUTION_ACTOR);
  const id = newId("can");
  const traffic = Math.max(1, Math.min(50, Math.round(pct)));
  await insertCanary(env, {
    id,
    role: p.role,
    proposal_id: p.id,
    candidate_agent: p.agent_id,
    candidate_genome: p.genome_id,
    champion_agent: champ.agent.id,
    champion_genome: champ.genome.id,
    traffic_pct: traffic,
    started_at: Date.now(),
  });
  await insertPromotion(env, {
    id: newId("promo"),
    role: p.role,
    kind: "canary_start",
    from_genome: champ.genome.id,
    to_genome: p.genome_id,
    from_agent: champ.agent.id,
    to_agent: p.agent_id,
    proposal_id: p.id,
    reason: `passed promotion gate; ${traffic}% canary`,
    detail: p.decision,
    actor: EVOLUTION_ACTOR,
  });
  await updateProposal(env, p.id, { stage: "canary" });
  await audit(env.DB, EVOLUTION_ACTOR, "evolution.canary_start", id, { role: p.role, candidate: p.genome_id, champion: champ.genome.id, pct: traffic });
  return id;
}

/** Which agent serves a request for `role`: the canary candidate for ~traffic_pct% of seeds, else the champion. */
export async function routeCanary(env: Env, role: string, requestSeed: string | number): Promise<{ agent_id: string; genome_id: string; canary_id?: string } | null> {
  const [c] = await runningCanaries(env, role);
  if (c && canaryRoute(`${c.id}|${requestSeed}`, c.traffic_pct / 100)) return { agent_id: c.candidate_agent, genome_id: c.candidate_genome, canary_id: c.id };
  const champ = await championOf(env, role);
  return champ ? { agent_id: champ.agent.id, genome_id: champ.genome.id } : null;
}

/** Record paired live observations (same task served/graded for both). */
export async function recordCanaryObservation(env: Env, canaryId: string, obs: { candidatePass: boolean; championPass: boolean }): Promise<void> {
  await addCanaryObs(env, canaryId, 1, obs.candidatePass ? 1 : 0, obs.championPass ? 1 : 0);
}

export interface CanaryDecision {
  canary_id: string;
  status: "running" | "promoted" | "rolled_back";
  obs: number;
  candidate_score: number;
  champion_score: number;
  reason?: string;
}

/**
 * Advance a canary: optionally run `samples` shadow observations, then decide with shouldRollback:
 * rollback → auto-rollback; enough observations without a drop → promote; else keep running.
 */
export async function evaluateCanary(env: Env, lab: LabLLM, canaryId: string, opts: CanaryOptions & EngineOptions = {}): Promise<CanaryDecision> {
  let c = await getCanary(env, canaryId);
  if (!c) throw new EngineError("not_found", `canary ${canaryId} not found`);
  const done = (x: CanaryRow): CanaryDecision => ({
    canary_id: x.id,
    status: x.status,
    obs: x.obs,
    candidate_score: x.obs ? r3(x.cand_pass / x.obs) : 0,
    champion_score: x.obs ? r3(x.champ_pass / x.obs) : 0,
    reason: x.reason ?? undefined,
  });
  if (c.status !== "running") return done(c);

  const champ = await championOf(env, c.role);
  if (!champ || champ.genome.id !== c.champion_genome) {
    await rollbackCanary(env, c, "the champion changed while the canary was running", "auto_rollback");
    return done((await getCanary(env, canaryId))!);
  }

  const samples = opts.samples ?? 6;
  if (samples > 0) {
    const cand = await mustGenome(env, c.candidate_genome);
    const exclude = [cand.lineage_id, `agent:${c.candidate_agent}`];
    const pool = await roleItems(env, c.role, ["public", "private"], exclude);
    if (pool.length) {
      const order = seededPick(pool, pool.length, c.id);
      const picked = Array.from({ length: Math.min(samples, pool.length) }, (_, k) => order[(c!.obs + k) % order.length]!);
      const judgeAgent = await pickJudge(env, cand);
      const cache: EvalCache = new Map();
      let cp = 0;
      let hp = 0;
      for (const it of picked) {
        const a = await evalItem(env, lab, cand, it, { context: "canary", ref: c.id, cache, reuse: false, judgeAgent, judges: opts.judges });
        const b = await evalItem(env, lab, champ.genome, it, { context: "canary", ref: c.id, cache, reuse: true, judgeAgent, judges: opts.judges });
        cp += a.pass ? 1 : 0;
        hp += b.pass ? 1 : 0;
      }
      await addCanaryObs(env, c.id, picked.length, cp, hp);
    }
    c = (await getCanary(env, canaryId))!;
  }

  const minN = opts.minN ?? 5;
  const cs = c.obs ? c.cand_pass / c.obs : NaN;
  const hs = c.obs ? c.champ_pass / c.obs : NaN;
  if (c.obs > 0 && shouldRollback({ canaryScore: cs, championScore: hs, n: c.obs, minN, maxDrop: opts.maxDrop ?? 0.05 })) {
    await rollbackCanary(env, c, `canary score ${r3(cs)} vs champion ${r3(hs)} over ${c.obs} observations`, "auto_rollback");
  } else if (c.obs >= (opts.promoteAfter ?? minN)) {
    await promoteCanary(env, c, `canary held: ${r3(cs)} vs champion ${r3(hs)} over ${c.obs} observations`, opts.keepStandby ?? 2);
  }
  return done((await getCanary(env, canaryId))!);
}

async function demoteToStandby(env: Env, agentId: string): Promise<string> {
  const reg = new Registry(env);
  const a = await reg.getAgent(agentId);
  if (!a || a.status !== "champion") return a?.status ?? "missing";
  try {
    await reg.setStatus(agentId, "candidate", EVOLUTION_ACTOR);
    return "candidate";
  } catch (e) {
    if (!(e instanceof GovernorError)) throw e;
    await reg.setStatus(agentId, "retired", EVOLUTION_ACTOR); // no room for a standby
    return "retired";
  }
}

async function trimStandby(env: Env, role: string, keep: number): Promise<string[]> {
  const live = new Set((await runningCanaries(env, role)).map((c) => c.candidate_agent));
  const rows = (await env.DB.prepare("SELECT id FROM agents WHERE role = ?1 AND status = 'candidate' ORDER BY updated_at DESC, id").bind(role).all<{ id: string }>()).results.filter(
    (r) => !live.has(r.id),
  );
  const retired: string[] = [];
  for (const r of rows.slice(Math.max(0, keep))) {
    await new Registry(env).setStatus(r.id, "retired", EVOLUTION_ACTOR);
    retired.push(r.id);
  }
  return retired;
}

async function promoteCanary(env: Env, c: CanaryRow, reason: string, keepStandby: number): Promise<void> {
  if (!(await decideCanary(env, c.id, "promoted", reason))) return;
  const reg = new Registry(env);
  const prev = await championOf(env, c.role);
  await reg.setStatus(c.candidate_agent, "champion", EVOLUTION_ACTOR); // moves the deployment pointer
  const prevStatus = prev && prev.agent.id !== c.candidate_agent ? await demoteToStandby(env, prev.agent.id) : "n/a";
  const retired = await trimStandby(env, c.role, keepStandby);
  const p = await getProposal(env, c.proposal_id);
  const delta = c.obs ? r3((c.cand_pass - c.champ_pass) / c.obs) : null;
  await insertPromotion(env, {
    id: newId("promo"),
    role: c.role,
    kind: "promote",
    from_genome: prev?.genome.id ?? c.champion_genome,
    to_genome: c.candidate_genome,
    from_agent: prev?.agent.id ?? c.champion_agent,
    to_agent: c.candidate_agent,
    proposal_id: c.proposal_id,
    reason,
    detail: { canary: c.id, obs: c.obs, cand_pass: c.cand_pass, champ_pass: c.champ_pass, previous_champion_status: prevStatus, standby_retired: retired },
    actor: EVOLUTION_ACTOR,
  });
  if (p) {
    await updateProposal(env, p.id, { stage: "promoted", reason });
    await addNote(env, { role: c.role, operator: p.operator, genome_id: c.candidate_genome, outcome: "promoted", note: `${p.operator}: ${p.note ?? ""} — promoted after canary (${reason})`, delta });
  }
  await audit(env.DB, EVOLUTION_ACTOR, "evolution.promote", c.role, { canary: c.id, from: prev?.genome.id, to: c.candidate_genome, previous_champion_status: prevStatus });
}

async function rollbackCanary(env: Env, c: CanaryRow, reason: string, kind: "auto_rollback", actor = EVOLUTION_ACTOR): Promise<void> {
  if (!(await decideCanary(env, c.id, "rolled_back", reason))) return;
  await retireAgent(env, c.candidate_agent);
  const p = await getProposal(env, c.proposal_id);
  await insertPromotion(env, {
    id: newId("promo"),
    role: c.role,
    kind,
    from_genome: c.candidate_genome,
    to_genome: c.champion_genome,
    from_agent: c.candidate_agent,
    to_agent: c.champion_agent,
    proposal_id: c.proposal_id,
    reason,
    detail: { canary: c.id, obs: c.obs, cand_pass: c.cand_pass, champ_pass: c.champ_pass },
    actor,
  });
  if (p) {
    await updateProposal(env, p.id, { stage: "rolled_back", reason });
    await addNote(env, {
      role: c.role,
      operator: p.operator,
      genome_id: c.candidate_genome,
      outcome: "rolled_back",
      note: `${p.operator}: ${p.note ?? ""} — rolled back (${reason})`,
      delta: c.obs ? r3((c.cand_pass - c.champ_pass) / c.obs) : null,
    });
  }
  await audit(env.DB, actor, "evolution.auto_rollback", c.role, { canary: c.id, candidate: c.candidate_genome, reason });
}

// ================================================================ owner rollback

export interface OwnerRollbackResult {
  role: string;
  from_genome: string | null;
  to_genome: string;
  from_agent: string | null;
  to_agent: string;
  changed: boolean;
}

/**
 * Owner-initiated rollback: point the role's deployment back at `toGenomeId` (any genome of that role).
 * Reuses a live agent of that genome (normally the standby previous champion) or creates one. The displaced
 * champion becomes a standby candidate; a running canary for the role is closed.
 */
export async function ownerRollback(env: Env, role: string, toGenomeId: string, actor = "owner"): Promise<OwnerRollbackResult> {
  if (actor.startsWith("agent:")) throw new EngineError("bad_request", "only the owner or the system may roll back a deployment");
  const reg = new Registry(env);
  const g = await reg.getGenome(toGenomeId);
  if (!g) throw new EngineError("not_found", `genome ${toGenomeId} not found`);
  if (g.role !== role) throw new EngineError("bad_request", `genome ${toGenomeId} is a ${g.role} genome, not ${role}`);
  const cur = await championOf(env, role);
  if (cur && cur.genome.id === toGenomeId)
    return { role, from_genome: cur.genome.id, to_genome: toGenomeId, from_agent: cur.agent.id, to_agent: cur.agent.id, changed: false };

  for (const c of await runningCanaries(env, role)) {
    if (await decideCanary(env, c.id, "rolled_back", "superseded by owner rollback")) {
      await retireAgent(env, c.candidate_agent);
      await updateProposal(env, c.proposal_id, { stage: "rolled_back", reason: "superseded by owner rollback" });
    }
  }

  let target = await env.DB.prepare("SELECT * FROM agents WHERE genome_id = ?1 AND status != 'retired' ORDER BY updated_at DESC LIMIT 1").bind(toGenomeId).first<AgentRow>();
  if (!target) {
    let id = `a_${g.lineage_id}_v${g.version}_${g.id.slice(2, 8)}`;
    if (await reg.getAgent(id)) id = `${id}_r${Date.now().toString(36)}`;
    target = await reg.createAgent(g, { id, status: "candidate", actor });
  }
  const path: Record<string, string[]> = { draft: ["sandboxed", "candidate"], sandboxed: ["candidate"], quarantined: ["sandboxed", "candidate"], candidate: [] };
  for (const s of path[target.status] ?? []) await reg.setStatus(target.id, s as any, actor);
  await reg.setStatus(target.id, "champion", actor); // moves the deployment pointer
  const prevStatus = cur && cur.agent.id !== target.id ? await demoteToStandby(env, cur.agent.id) : "n/a";
  await insertPromotion(env, {
    id: newId("promo"),
    role,
    kind: "owner_rollback",
    from_genome: cur?.genome.id ?? null,
    to_genome: toGenomeId,
    from_agent: cur?.agent.id ?? null,
    to_agent: target.id,
    proposal_id: null,
    reason: "owner rollback",
    detail: { previous_champion_status: prevStatus },
    actor,
  });
  await audit(env.DB, actor, "evolution.owner_rollback", role, { from: cur?.genome.id ?? null, to: toGenomeId, agent: target.id });
  return { role, from_genome: cur?.genome.id ?? null, to_genome: toGenomeId, from_agent: cur?.agent.id ?? null, to_agent: target.id, changed: true };
}

// ================================================================ one generation

export interface GenerationResult {
  role: string;
  proposal_id: string;
  operator: string;
  genome_id: string | null;
  agent_id: string | null;
  outcome: "canary" | "lost" | "rejected" | "aborted";
  stage: string;
  reason?: string;
  tournament_id?: string;
  canary_id?: string;
  llm_calls: number;
}

/** Serializable position of one generation (stored in a job's state). Stages persist on the proposal row. */
export interface GenerationCursor {
  input: ProposeInput & EngineOptions;
  pid: string | null;
  phase: "propose" | "static" | "sandbox" | "tournament" | "gate" | "done";
  calls: number;
  result: GenerationResult | null;
}

export const GENERATION_PHASES = ["propose", "static", "sandbox", "tournament", "gate"] as const;

export function generationInit(input: ProposeInput & EngineOptions): GenerationCursor {
  return { input, pid: null, phase: "propose", calls: 0, result: null };
}

async function generationOut(env: Env, c: GenerationCursor, outcome: GenerationResult["outcome"], extra: Partial<GenerationResult> = {}): Promise<GenerationResult> {
  const p = await getProposal(env, c.pid!);
  return {
    role: c.input.role,
    proposal_id: c.pid!,
    operator: p?.operator ?? "",
    genome_id: p?.genome_id ?? null,
    agent_id: p?.agent_id ?? null,
    outcome,
    stage: p?.stage ?? "proposed",
    reason: p?.reason ?? undefined,
    tournament_id: p?.tournament_id ?? undefined,
    llm_calls: c.calls,
    ...extra,
  };
}

/**
 * Advance one generation by one stage (propose, static, sandbox, tournament, gate). Budget / kill-switch errors
 * abort cleanly (proposal closed as "aborted", no bandit update). `cache` may be shared between the sandbox and
 * tournament stages when they run in the same invocation; across invocations it is simply rebuilt.
 */
export async function generationStep(env: Env, lab: LabLLM, c: GenerationCursor, cache: EvalCache = new Map()): Promise<void> {
  if (c.phase === "done") return;
  const before = lab.calls;
  const finish = async (outcome: GenerationResult["outcome"], extra: Partial<GenerationResult> = {}) => {
    c.calls += lab.calls - before;
    c.result = await generationOut(env, c, outcome, extra);
    c.phase = "done";
  };
  try {
    switch (c.phase) {
      case "propose": {
        const pr = await propose(env, lab, { ...c.input, operator: c.input.operator });
        c.pid = pr.proposal.id;
        if (!pr.ok) return await finish("rejected");
        c.phase = "static";
        break;
      }
      case "static":
        if (!(await staticStage(env, lab, c.pid!)).pass) return await finish("rejected");
        c.phase = "sandbox";
        break;
      case "sandbox":
        if (!(await sandboxStage(env, lab, c.pid!, c.input, cache)).pass) return await finish("rejected");
        c.phase = "tournament";
        break;
      case "tournament":
        await tournamentStage(env, lab, c.pid!, c.input, cache);
        c.phase = "gate";
        break;
      case "gate": {
        const g = await gateStage(env, c.pid!, c.input, lab);
        return await finish(g.pass ? "canary" : "lost", { canary_id: g.canary_id });
      }
    }
    c.calls += lab.calls - before;
  } catch (e) {
    if (!(e instanceof LabBudgetError) || !c.pid) throw e;
    const p = await getProposal(env, c.pid);
    if (p && !["rejected", "lost", "canary", "promoted", "rolled_back"].includes(p.stage)) {
      // not the operator's fault: no bandit update, no note
      await updateProposal(env, c.pid, { stage: "rejected", reason: `aborted: ${e.message}` });
      await retireAgent(env, p.agent_id);
      await audit(env.DB, EVOLUTION_ACTOR, "evolution.aborted", c.pid, { reason: e.message });
    }
    await finish("aborted", { reason: `aborted: ${e.message}` });
  }
}

/** propose → static → sandbox → tournament → gate for one role. Budget / kill-switch errors abort cleanly. */
export async function runGeneration(env: Env, lab: LabLLM, input: ProposeInput & EngineOptions): Promise<GenerationResult> {
  const c = generationInit(input);
  const cache: EvalCache = new Map();
  while (c.phase !== "done") await generationStep(env, lab, c, cache);
  return c.result!;
}

// ================================================================ tick

export interface TickOptions extends EngineOptions, CanaryOptions {
  maxProposals?: number; // default 1
  roles?: Role[];
  lockTtlMs?: number; // default 15 min
  /** Stop before a generation when fewer lab calls than this remain in the tick budget. Default 10. */
  minCallsPerGeneration?: number;
  /** Advance running canaries first (default true). */
  advanceCanaries?: boolean;
  seed?: string | number;
  holder?: string;
}

export interface TickSummary {
  status: "ok" | "killed" | "locked";
  stopped?: "killed" | "population_cap" | "tick_budget" | "daily_budget" | "no_roles";
  generations: GenerationResult[];
  canaries: CanaryDecision[];
  llm_calls: number;
  roles: string[];
  started_at: number;
  finished_at: number;
}

/** Roles that can evolve now: a deployed champion and at least one active held-out item. */
export async function evolvableRoles(env: Env): Promise<Role[]> {
  const rows = (await env.DB.prepare("SELECT DISTINCT role FROM deployments WHERE active = 1 ORDER BY role").all<{ role: string }>()).results;
  const out: Role[] = [];
  for (const r of rows) if ((await roleItems(env, r.role, ["private"])).length) out.push(r.role as Role);
  return out;
}

export async function tick(env: Env, lab: LabLLM, opts: TickOptions = {}): Promise<TickSummary> {
  const started_at = Date.now();
  const start = lab.calls;
  const gov = new Governor(env);
  const summary: TickSummary = { status: "ok", generations: [], canaries: [], llm_calls: 0, roles: [], started_at, finished_at: started_at };
  const fin = () => ({ ...summary, llm_calls: lab.calls - start, finished_at: Date.now() });
  if ((await gov.isKilled()).killed) {
    summary.status = "killed";
    summary.stopped = "killed";
    return fin();
  }

  const holder = opts.holder ?? newId("tick");
  if (!(await acquireLock(env, holder, opts.lockTtlMs ?? 15 * 60_000))) {
    summary.status = "locked";
    return fin();
  }
  try {
    const budgetStop = (e: unknown): boolean => {
      if (!(e instanceof LabBudgetError)) return false;
      summary.stopped = e.scope === "killed" ? "killed" : e.scope === "daily" ? "daily_budget" : "tick_budget";
      return true;
    };
    if (opts.advanceCanaries !== false) {
      for (const c of await runningCanaries(env)) {
        if (opts.roles && !opts.roles.includes(c.role as Role)) continue;
        try {
          summary.canaries.push(await evaluateCanary(env, lab, c.id, opts));
        } catch (e) {
          if (budgetStop(e)) return fin();
          throw e;
        }
      }
    }
    const busy = new Set((await runningCanaries(env)).map((c) => c.role));
    const roles = (await evolvableRoles(env)).filter((r) => (!opts.roles || opts.roles.includes(r)) && !busy.has(r));
    summary.roles = roles;
    if (!roles.length) {
      summary.stopped = "no_roles";
      return fin();
    }
    const cursor = Number((await gov.getState(RR_KEY)) ?? 0) || 0;
    const max = Math.max(0, opts.maxProposals ?? 1);
    let i = 0;
    for (; i < max; i++) {
      if ((await gov.isKilled()).killed) {
        summary.stopped = "killed";
        break;
      }
      try {
        await gov.assertPopulationRoom("sandboxed");
      } catch (e) {
        if (!(e instanceof GovernorError)) throw e;
        summary.stopped = "population_cap";
        break;
      }
      if (lab.remaining < (opts.minCallsPerGeneration ?? 10)) {
        summary.stopped = "tick_budget";
        break;
      }
      const role = roles[(cursor + i) % roles.length]!;
      const busyNow = (await runningCanaries(env, role)).length > 0;
      if (busyNow) continue;
      let gen: GenerationResult;
      try {
        gen = await runGeneration(env, lab, { ...opts, role, seed: `${opts.seed ?? started_at}|${cursor + i}` });
      } catch (e) {
        if (e instanceof GovernorError && e.code === "population_cap") {
          summary.stopped = "population_cap";
          break;
        }
        if (budgetStop(e)) break;
        throw e;
      }
      summary.generations.push(gen);
      if (gen.outcome === "aborted") {
        summary.stopped = /kill/i.test(gen.reason ?? "") ? "killed" : /daily/i.test(gen.reason ?? "") ? "daily_budget" : "tick_budget";
        i++;
        break;
      }
    }
    await gov.setState(RR_KEY, String((cursor + i) % Math.max(1, roles.length)));
    return fin();
  } finally {
    await releaseLock(env, holder);
    await audit(env.DB, EVOLUTION_ACTOR, "evolution.tick", null, {
      status: summary.status,
      stopped: summary.stopped ?? null,
      generations: summary.generations.map((g) => ({ role: g.role, op: g.operator, outcome: g.outcome })),
      canaries: summary.canaries.map((c) => ({ id: c.canary_id, status: c.status })),
    });
  }
}

