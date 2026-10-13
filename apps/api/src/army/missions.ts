/**
 * Mission contracts (master plan §2.5). A contract is written BEFORE any execution and stored in D1. It carries the
 * goal, budget, deadline, machine-checkable success criteria, a REQUIRED rollback plan, the assigned swarm
 * (planner → workers → verifier, verifier from a different lineage — art. 6), the tool/data/egress scope workers may
 * be granted, and the approvals the matrix demands. Status machine:
 *
 *   draft → approved → running → verifying → done
 *     ↘ failed   ↘ failed  ↘ failed/rolled_back  ↘ failed/rolled_back
 *   failed → rolled_back
 *
 * Only the verifier step may set "done" — never the agents that executed. Approval is owner-only; two-key action
 * classes need the owner key (step-up TOTP where the matrix says so) + a second key; L5 is owner-only, one mission per
 * agent at a time, ≤ 7 days.
 */
import type { Tier } from "../constitution";
import type { Env } from "../env";
import { newId, safeJsonParse } from "../util";
import { armyAudit } from "./audit";
import { type ActionClass, type ApprovalKey, type AutonomyLevel, checkApprovals, isActionClass, isAutonomy, isRisk, L5_MAX_MS, requiredApprovals, type Requirement, type RiskTier } from "./autonomy";
import { mintCapability, revokeCapability } from "./capability";
import { isDivision, type DivisionId } from "./divisions";

export type MissionStatus = "draft" | "approved" | "running" | "verifying" | "done" | "failed" | "rolled_back";
export const MISSION_STATUSES: MissionStatus[] = ["draft", "approved", "running", "verifying", "done", "failed", "rolled_back"];

export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = Object.freeze({
  draft: Object.freeze(["approved", "failed"] as MissionStatus[]),
  approved: Object.freeze(["running", "failed"] as MissionStatus[]),
  running: Object.freeze(["verifying", "failed", "rolled_back"] as MissionStatus[]),
  verifying: Object.freeze(["done", "failed", "rolled_back"] as MissionStatus[]),
  failed: Object.freeze(["rolled_back"] as MissionStatus[]),
  done: Object.freeze([] as MissionStatus[]),
  rolled_back: Object.freeze([] as MissionStatus[]),
});

export const canMissionTransition = (from: MissionStatus, to: MissionStatus) => MISSION_TRANSITIONS[from]?.includes(to) ?? false;

export type CriterionKind = "all_subtasks_ok" | "min_subtasks_ok" | "output_contains" | "no_denials" | "max_failure_rate";
export const CRITERION_KINDS: CriterionKind[] = ["all_subtasks_ok", "min_subtasks_ok", "output_contains", "no_denials", "max_failure_rate"];

export interface Criterion {
  id: string;
  kind: CriterionKind;
  value?: number | string;
}

export interface RollbackPlan {
  steps: string[];
  /** Reversible by construction (e.g. outputs only)? Informational. */
  reversible: boolean;
}

export interface SwarmAssignment {
  planner: string;
  workers: string[];
  verifier: string;
}

export interface MissionContract {
  mission_id: string;
  goal: string;
  owner: "omar" | "org" | "customer";
  success_criteria: Criterion[];
  budget: { llm_calls: number; tool_calls: number; wall_s: number; credits: number };
  deadline: number;
  autonomy_level: AutonomyLevel;
  action_class: ActionClass;
  risk_tier: RiskTier;
  division: DivisionId | null;
  assigned_swarm: SwarmAssignment;
  /** Upper bound of what worker capability tokens may carry. */
  scope: { tools: string[]; max_tier: Tier; data_scopes: string[]; egress: string[] };
  deliverables: string[];
  verifier: "checker" | "judge_panel" | "human";
  rollback_plan: RollbackPlan;
  /** Planned subtasks (optional; otherwise the planner writes them). Each names the tool it needs. */
  subtasks?: { title: string; tool: string; tier?: Tier; data_scope?: string; egress_domain?: string }[];
  requirement: Requirement;
  created_at: number;
}

export interface MissionRow {
  id: string;
  goal: string;
  contract: MissionContract;
  status: MissionStatus;
  autonomy: AutonomyLevel;
  action_class: ActionClass;
  risk_tier: RiskTier;
  division: string | null;
  approvals: ApprovalKey[];
  job_id: string | null;
  verdict: unknown;
  rollback: unknown;
  created_by: string;
  deadline: number;
  created_at: number;
  updated_at: number;
}

export class MissionError extends Error {
  constructor(
    public code: "bad_request" | "not_found" | "bad_transition" | "not_owner" | "approvals_missing" | "step_up_required" | "l5_rule" | "forbidden" | "verifier_conflict" | "killed",
    message: string,
    public details?: string[],
  ) {
    super(message);
  }
}

const MAX_BUDGET = { llm_calls: 400, tool_calls: 400, wall_s: 7 * 86400, credits: 100_000 };
const strs = (v: unknown, max = 32, len = 300) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((s) => s.trim().slice(0, len)).slice(0, max) : []);
const clampInt = (v: unknown, def: number, max: number) => {
  const n = Math.floor(Number(v ?? def));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def;
};

export interface MissionInput {
  goal: string;
  owner?: MissionContract["owner"];
  success_criteria?: (Criterion | string)[];
  budget?: Partial<MissionContract["budget"]>;
  deadline?: number;
  /** Alternative to deadline: hours from now. */
  deadline_hours?: number;
  autonomy_level?: AutonomyLevel;
  action_class?: ActionClass;
  risk_tier?: RiskTier;
  division?: DivisionId;
  assigned_swarm?: Partial<SwarmAssignment>;
  scope?: Partial<MissionContract["scope"]>;
  deliverables?: string[];
  verifier?: MissionContract["verifier"];
  rollback_plan?: Partial<RollbackPlan> | string[] | string;
  subtasks?: MissionContract["subtasks"];
}

function normCriteria(v: unknown): Criterion[] {
  const out: Criterion[] = [];
  for (const [i, c] of (Array.isArray(v) ? v : []).slice(0, 16).entries()) {
    if (typeof c === "string" && c.trim()) out.push({ id: `c${i + 1}`, kind: "output_contains", value: c.trim().slice(0, 200) });
    else if (c && typeof c === "object" && CRITERION_KINDS.includes((c as Criterion).kind))
      out.push({ id: typeof (c as Criterion).id === "string" ? (c as Criterion).id.slice(0, 40) : `c${i + 1}`, kind: (c as Criterion).kind, value: (c as Criterion).value });
  }
  return out.length ? out : [{ id: "c1", kind: "all_subtasks_ok" }, { id: "c2", kind: "no_denials" }];
}

function normRollback(v: MissionInput["rollback_plan"]): RollbackPlan | null {
  if (typeof v === "string") return v.trim() ? { steps: [v.trim().slice(0, 500)], reversible: false } : null;
  if (Array.isArray(v)) {
    const steps = strs(v, 20, 500);
    return steps.length ? { steps, reversible: false } : null;
  }
  if (v && typeof v === "object") {
    const steps = strs(v.steps, 20, 500);
    return steps.length ? { steps, reversible: !!v.reversible } : null;
  }
  return null;
}

/** Pure validation → contract (no I/O). Throws MissionError. */
export function buildContract(input: MissionInput, nowMs = Date.now()): MissionContract {
  if (!input || typeof input.goal !== "string" || input.goal.trim().length < 3) throw new MissionError("bad_request", "goal is required (≥ 3 chars)");
  const rollback = normRollback(input.rollback_plan);
  if (!rollback) throw new MissionError("bad_request", "rollback_plan is required (at least one step)");
  const autonomy = input.autonomy_level ?? "L2";
  if (!isAutonomy(autonomy)) throw new MissionError("bad_request", "autonomy_level must be L0..L5");
  const action_class = input.action_class ?? "think_memory";
  if (!isActionClass(action_class)) throw new MissionError("bad_request", "unknown action_class");
  const risk = input.risk_tier ?? 1;
  if (!isRisk(risk)) throw new MissionError("bad_request", "risk_tier must be 0..4");
  if (input.division !== undefined && !isDivision(input.division)) throw new MissionError("bad_request", "unknown division");
  const deadline = typeof input.deadline === "number" ? input.deadline : nowMs + Math.max(1, Number(input.deadline_hours ?? 24)) * 3_600_000;
  if (!Number.isFinite(deadline) || deadline <= nowMs) throw new MissionError("bad_request", "deadline must be in the future");
  if (autonomy === "L5" && deadline - nowMs > L5_MAX_MS) throw new MissionError("l5_rule", "an L5 mission may last at most 7 days");
  const requirement = requiredApprovals(action_class, risk, autonomy, { inL5Contract: autonomy === "L5" });
  if (requirement.decision === "forbidden") throw new MissionError("forbidden", `${action_class} at R${risk} is forbidden: ${requirement.reason}`);
  const sw = input.assigned_swarm ?? {};
  const workers = strs(sw.workers, 8, 80);
  const swarm: SwarmAssignment = { planner: typeof sw.planner === "string" && sw.planner ? sw.planner : "army:planner", workers: workers.length ? workers : ["army:worker-1", "army:worker-2"], verifier: typeof sw.verifier === "string" && sw.verifier ? sw.verifier : "army:verifier" };
  if (swarm.workers.includes(swarm.verifier) || swarm.planner === swarm.verifier) throw new MissionError("verifier_conflict", "the verifier must not be the planner or a worker");
  const sc = input.scope ?? {};
  const tools = strs(sc.tools, 24, 80);
  const maxTier = (typeof sc.max_tier === "number" && sc.max_tier >= 0 && sc.max_tier <= 4 ? Math.floor(sc.max_tier) : 1) as Tier;
  const b = input.budget ?? {};
  const subtasks = Array.isArray(input.subtasks)
    ? input.subtasks
        .filter((s) => s && typeof s.title === "string" && typeof s.tool === "string")
        .slice(0, 12)
        .map((s) => ({ title: s.title.slice(0, 200), tool: s.tool.slice(0, 80), tier: (typeof s.tier === "number" && s.tier >= 0 && s.tier <= 4 ? s.tier : 0) as Tier, data_scope: s.data_scope, egress_domain: s.egress_domain }))
    : undefined;
  return {
    mission_id: newId("msn"),
    goal: input.goal.trim().slice(0, 2000),
    owner: input.owner === "customer" || input.owner === "org" ? input.owner : "omar",
    success_criteria: normCriteria(input.success_criteria),
    budget: { llm_calls: clampInt(b.llm_calls, 24, MAX_BUDGET.llm_calls), tool_calls: clampInt(b.tool_calls, 40, MAX_BUDGET.tool_calls), wall_s: clampInt(b.wall_s, 3600, MAX_BUDGET.wall_s), credits: clampInt(b.credits, 0, MAX_BUDGET.credits) },
    deadline,
    autonomy_level: autonomy,
    action_class,
    risk_tier: risk,
    division: input.division ?? null,
    assigned_swarm: swarm,
    scope: { tools: tools.length ? tools : ["think", "memory.search", "memory.write"], max_tier: maxTier, data_scopes: strs(sc.data_scopes, 16, 120), egress: strs(sc.egress, 16, 120).map((d) => d.toLowerCase()) },
    deliverables: strs(input.deliverables, 16, 300),
    verifier: input.verifier === "judge_panel" || input.verifier === "human" ? input.verifier : "checker",
    rollback_plan: rollback,
    subtasks,
    requirement,
    created_at: nowMs,
  };
}

type Raw = Omit<MissionRow, "contract" | "approvals" | "verdict" | "rollback"> & { contract: string; approvals: string; verdict: string | null; rollback: string | null };
const toRow = (r: Raw): MissionRow => ({ ...r, contract: JSON.parse(r.contract), approvals: safeJsonParse<ApprovalKey[]>(r.approvals) ?? [], verdict: safeJsonParse(r.verdict), rollback: safeJsonParse(r.rollback) });

async function lineageOf(env: Env, agentId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT lineage_id FROM agents WHERE id = ?1").bind(agentId).first<{ lineage_id: string }>())?.lineage_id ?? null;
}

/** Art. 6: the verifier's lineage must differ from every worker's (checked when the agents are registered). */
export async function verifierIndependent(env: Env, swarm: SwarmAssignment): Promise<string[]> {
  const v = await lineageOf(env, swarm.verifier);
  if (!v) return [];
  const clash: string[] = [];
  for (const w of [...swarm.workers, swarm.planner]) if ((await lineageOf(env, w)) === v) clash.push(w);
  return clash;
}

export async function createMission(env: Env, input: MissionInput, actor = "owner"): Promise<MissionRow> {
  const c = buildContract(input);
  if (c.autonomy_level === "L5" && actor !== "owner") throw new MissionError("l5_rule", "only the owner can create an L5 mission");
  const clash = await verifierIndependent(env, c.assigned_swarm);
  if (clash.length) throw new MissionError("verifier_conflict", "verifier shares a lineage with the swarm", clash);
  const ts = Date.now();
  await env.DB.prepare(
    `INSERT INTO army_missions (id, goal, contract, status, autonomy, action_class, risk_tier, division, approvals, created_by, deadline, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, '[]', ?8, ?9, ?10, ?10)`,
  )
    .bind(c.mission_id, c.goal, JSON.stringify(c), c.autonomy_level, c.action_class, c.risk_tier, c.division, actor, c.deadline, ts)
    .run();
  await armyAudit(env.DB, actor, "army.mission.create", c.mission_id, { action_class: c.action_class, risk: c.risk_tier, autonomy: c.autonomy_level, requirement: c.requirement.decision, two_key: c.requirement.two_key });
  return (await getMission(env, c.mission_id))!;
}

export async function getMission(env: Env, id: string): Promise<MissionRow | null> {
  const r = await env.DB.prepare("SELECT * FROM army_missions WHERE id = ?1").bind(id).first<Raw>();
  return r ? toRow(r) : null;
}

export async function listMissions(env: Env, opts: { status?: string; limit?: number } = {}): Promise<MissionRow[]> {
  const lim = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const q = opts.status
    ? env.DB.prepare(`SELECT * FROM army_missions WHERE status = ?1 ORDER BY created_at DESC LIMIT ${lim}`).bind(opts.status)
    : env.DB.prepare(`SELECT * FROM army_missions ORDER BY created_at DESC LIMIT ${lim}`);
  return (await q.all<Raw>()).results.map(toRow);
}

/** Compare-and-set status transition through the state machine. */
export async function transitionMission(env: Env, id: string, to: MissionStatus, actor: string, patch: { verdict?: unknown; rollback?: unknown; job_id?: string; approvals?: ApprovalKey[] } = {}): Promise<MissionRow> {
  const m = await getMission(env, id);
  if (!m) throw new MissionError("not_found", `mission ${id} not found`);
  if (!canMissionTransition(m.status, to)) throw new MissionError("bad_transition", `cannot go ${m.status} → ${to}`);
  const sets = ["status = ?3", "updated_at = ?4"];
  const args: unknown[] = [id, m.status, to, Date.now()];
  if (patch.verdict !== undefined) sets.push(`verdict = ?${args.push(JSON.stringify(patch.verdict))}`);
  if (patch.rollback !== undefined) sets.push(`rollback = ?${args.push(JSON.stringify(patch.rollback))}`);
  if (patch.job_id !== undefined) sets.push(`job_id = ?${args.push(patch.job_id)}`);
  if (patch.approvals !== undefined) sets.push(`approvals = ?${args.push(JSON.stringify(patch.approvals))}`);
  const r = await env.DB.prepare(`UPDATE army_missions SET ${sets.join(", ")} WHERE id = ?1 AND status = ?2 RETURNING id`).bind(...args).first();
  if (!r) throw new MissionError("bad_transition", "mission changed concurrently");
  await armyAudit(env.DB, actor, `army.mission.${to}`, id, { from: m.status });
  return (await getMission(env, id))!;
}

export interface ApproveOpts {
  actor: string;
  /** The owner passed a fresh TOTP step-up for this approval. */
  stepUpOk?: boolean;
  /** Additional keys (court / security_council) collected for two-key classes. */
  keys?: ApprovalKey[];
  note?: string;
}

/**
 * Owner approval of a draft mission. The owner key is always present (actor must be "owner"); two-key classes also
 * need a second key; step-up cells need stepUpOk. L5: one live L5 grant per agent, ≤ 7 days, bound to this mission.
 */
export async function approveMission(env: Env, id: string, opts: ApproveOpts): Promise<MissionRow> {
  if (opts.actor !== "owner") throw new MissionError("not_owner", "only the owner can approve missions");
  const m = await getMission(env, id);
  if (!m) throw new MissionError("not_found", `mission ${id} not found`);
  if (m.status !== "draft") throw new MissionError("bad_transition", `mission is ${m.status}`);
  if (m.deadline <= Date.now()) throw new MissionError("bad_request", "mission deadline has passed");
  const c = m.contract;
  const ownerKey: ApprovalKey = { approver: "owner", by: "owner", step_up: !!opts.stepUpOk, at: Date.now() };
  const extra = (opts.keys ?? []).filter((k) => k && k.approver !== "owner" && typeof k.by === "string" && k.by && k.by !== "owner").map((k) => ({ approver: k.approver, by: k.by.slice(0, 80), division: k.division ?? null, at: Date.now() }));
  const keys = [ownerKey, ...extra];
  const req = c.requirement;
  // The owner approving the mission is itself the per-mission gate; the matrix may demand more.
  if (req.decision === "needs_approval") {
    const chk = checkApprovals(req, keys, { id: c.assigned_swarm.planner, division: c.division });
    if (!chk.satisfied) {
      if (chk.missing.every((x) => x.includes("step-up"))) throw new MissionError("step_up_required", "this approval needs a fresh TOTP code (step-up)", chk.missing);
      throw new MissionError("approvals_missing", "approvals missing", chk.missing);
    }
  }
  if (c.autonomy_level === "L5") {
    if (!opts.stepUpOk) throw new MissionError("step_up_required", "L5 grants need a fresh TOTP code (step-up)");
    const agent = c.assigned_swarm.planner;
    const live = await env.DB.prepare("SELECT mission_id FROM army_l5_grants WHERE agent_id = ?1 AND revoked_at IS NULL AND expires_at > ?2").bind(agent, Date.now()).first<{ mission_id: string }>();
    if (live && live.mission_id !== id) throw new MissionError("l5_rule", `agent ${agent} already holds L5 for mission ${live.mission_id} (one mission at a time)`);
    const exp = Math.min(m.deadline, Date.now() + L5_MAX_MS);
    await env.DB.prepare("INSERT OR REPLACE INTO army_l5_grants (mission_id, agent_id, granted_by, granted_at, expires_at) VALUES (?1, ?2, 'owner', ?3, ?4)").bind(id, agent, Date.now(), exp).run();
    await armyAudit(env.DB, "owner", "army.l5.grant", id, { agent, expires_at: exp });
  }
  const out = await transitionMission(env, id, "approved", "owner", { approvals: keys });
  if (opts.note) await armyAudit(env.DB, "owner", "army.mission.note", id, { note: opts.note.slice(0, 500) });
  return out;
}

/** Live L5 grant for (agent, mission), if any. */
export async function l5Grant(env: Env, agentId: string, missionId: string): Promise<{ expires_at: number } | null> {
  return env.DB.prepare("SELECT expires_at FROM army_l5_grants WHERE agent_id = ?1 AND mission_id = ?2 AND revoked_at IS NULL AND expires_at > ?3").bind(agentId, missionId, Date.now()).first<{ expires_at: number }>();
}

/** Mint the mission's root capability for the planner (scope = contract scope; ttl ≤ min(deadline, 24 h)). */
export async function mintMissionRoot(env: Env, m: MissionRow): Promise<{ token: string; token_id: string }> {
  const c = m.contract;
  const ttl = Math.max(60, Math.min(24 * 3600, Math.floor((m.deadline - Date.now()) / 1000)));
  const { token, body } = await mintCapability(
    env,
    { agent_id: c.assigned_swarm.planner, mission_id: m.id, tools: c.scope.tools, max_tier: c.scope.max_tier, data_scopes: c.scope.data_scopes, egress: c.scope.egress, ttl_s: ttl, max_calls: Math.max(1, c.budget.tool_calls), spend_cap_usd: 0 },
    { actor: "army.mission" },
  );
  return { token, token_id: body.token_id };
}

/**
 * Roll a mission back: run (record) the rollback plan, revoke every capability minted for it and its L5 grant.
 * Allowed from running / verifying / failed.
 */
export async function rollbackMission(env: Env, id: string, reason: string, actor: string): Promise<MissionRow> {
  const m = await getMission(env, id);
  if (!m) throw new MissionError("not_found", `mission ${id} not found`);
  if (!canMissionTransition(m.status, "rolled_back")) throw new MissionError("bad_transition", `cannot roll back a ${m.status} mission`);
  const caps = (await env.DB.prepare("SELECT id FROM army_capabilities WHERE mission_id = ?1 AND revoked_at IS NULL AND parent_id IS NULL").bind(id).all<{ id: string }>()).results;
  let revoked = 0;
  for (const c of caps) revoked += await revokeCapability(env, c.id, `mission rollback: ${reason}`.slice(0, 200), actor);
  // Children whose root was already revoked elsewhere.
  const rest = await env.DB.prepare("UPDATE army_capabilities SET revoked_at = ?2, revoke_reason = 'mission rollback' WHERE mission_id = ?1 AND revoked_at IS NULL").bind(id, Date.now()).run();
  revoked += rest.meta?.changes ?? 0;
  await env.DB.prepare("UPDATE army_l5_grants SET revoked_at = ?2 WHERE mission_id = ?1 AND revoked_at IS NULL").bind(id, Date.now()).run();
  const record = { reason: reason.slice(0, 500), at: Date.now(), from: m.status, steps: m.contract.rollback_plan.steps.map((s, i) => ({ n: i + 1, step: s, status: "executed" as const })), capabilities_revoked: revoked };
  return transitionMission(env, id, "rolled_back", actor, { rollback: record });
}
