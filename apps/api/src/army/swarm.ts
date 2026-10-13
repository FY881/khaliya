/**
 * "army.mission" job — the swarm orchestrator (master plan §2.6): planner → workers → verifier, run by the existing
 * JobRunner in small resumable steps. Every step makes AT MOST 1 LLM call (the contract allows ≤ 2), all through the
 * runner's LabLLM (lab budget share + job max_calls), so the swarm can never starve the org's free quota.
 *
 *   start   kill check, mint the mission's root capability for the planner                 (0 LLM calls)
 *   plan    planner splits the goal into ≤ 8 subtasks (contract subtasks win; mock = deterministic) (1 call)
 *   work    one subtask per step: kill check → mint an attenuated worker token → capability check
 *           (useCapability: signature, revocation list, call counter, scope) → simulated gateway execution (1 call)
 *           circuit breaker: > 30 % of subtasks failed/denied → stop, fail, roll back (OWASP ASI08)
 *   verify  running → verifying; deterministic criteria + verifier call (≠ worker lineage)  (1 call)
 *           verifying → done | failed → rolled_back
 *
 * Tools are NOT executed for real: workers pass the same capability check the ToolGateway will call, then the
 * "execution" is the worker's LLM write-up (gateway: "simulated"). Mock mode (LLM_MODE=mock) is fully deterministic.
 */
import type { Tier } from "../constitution";
import type { Env } from "../env";
import type { LabLLM } from "../eval/llm";
import { HANDLERS, type JobHandler } from "../jobs/handlers";
import { jobAccepted, startJob } from "../jobs/routes";
import type { JobRow } from "../jobs/store";
import { TOOL_MAP } from "../tools/catalog";
import { extractJson } from "../util";
import { armyAudit } from "./audit";
import { mintCapability, useCapability } from "./capability";
import { armyKillCheck } from "./killswitch";
import { type Criterion, getMission, MissionError, type MissionRow, mintMissionRoot, rollbackMission, transitionMission } from "./missions";

export const ARMY_MISSION_KIND = "army.mission";
export const MAX_SUBTASKS = 8;
export const BREAKER_RATIO = 0.3;
export const WORKER_TOKEN_TTL_S = 900;

export interface Subtask {
  id: string;
  title: string;
  tool: string;
  tier: Tier;
  agent: string;
  data_scope?: string;
  egress_domain?: string;
  status: "pending" | "ok" | "denied" | "failed";
  reason?: string;
  output?: string;
  token_id?: string;
}

export interface SwarmState {
  mission_id: string;
  phase: "start" | "plan" | "work" | "verify" | "done";
  root_token: string | null;
  subtasks: Subtask[];
  wi: number;
  steps: number;
  outcome: "done" | "failed" | "rolled_back" | "killed" | null;
  stopped: string | null;
  verdict: { pass: boolean; criteria: { id: string; kind: string; ok: boolean; detail?: string }[]; verifier: string; llm_note?: string } | null;
}

const tierOfTool = (tool: string, fallback: Tier = 0): Tier => (TOOL_MAP[tool]?.tier as Tier | undefined) ?? fallback;

function isMock(env: Env) {
  return (env.LLM_MODE ?? "auto") === "mock" || (!env.GEMINI_KEY && !env.OPENROUTER_KEY && !env.AI);
}

/** Deterministic plan: contract subtasks if given, else one per (worker × scope tool), capped. */
export function deterministicPlan(m: MissionRow): Subtask[] {
  const c = m.contract;
  const workers = c.assigned_swarm.workers;
  const planned = c.subtasks?.length
    ? c.subtasks.map((s) => ({ title: s.title, tool: s.tool, tier: (s.tier ?? tierOfTool(s.tool)) as Tier, data_scope: s.data_scope, egress_domain: s.egress_domain }))
    : c.scope.tools.slice(0, Math.max(2, workers.length)).map((t, i) => ({ title: `part ${i + 1} of: ${c.goal.slice(0, 80)}`, tool: t, tier: tierOfTool(t) }));
  return planned.slice(0, MAX_SUBTASKS).map((p, i) => ({ id: `st${i + 1}`, ...p, agent: workers[i % workers.length], status: "pending" as const }));
}

function planPrompt(m: MissionRow): string {
  const c = m.contract;
  return [
    "You are the planner of an agent swarm. Split the goal into 2-6 small subtasks.",
    `GOAL: ${c.goal}`,
    `ALLOWED TOOLS: ${c.scope.tools.join(", ")}`,
    `DELIVERABLES: ${c.deliverables.join("; ") || "(none listed)"}`,
    'Reply with JSON only: {"subtasks":[{"title":"...","tool":"<one allowed tool>"}]}',
  ].join("\n");
}

async function plan(env: Env, lab: LabLLM, m: MissionRow): Promise<Subtask[]> {
  const base = deterministicPlan(m);
  const res = await lab.complete(m.contract.assigned_swarm.planner, { messages: [{ role: "user", content: planPrompt(m) }], temperature: 0, maxTokens: 600, json: true });
  if (isMock(env) || m.contract.subtasks?.length) return base;
  const j = extractJson<{ subtasks?: { title?: unknown; tool?: unknown }[] }>(res.text);
  const workers = m.contract.assigned_swarm.workers;
  const parsed = (j?.subtasks ?? [])
    .filter((s) => typeof s?.title === "string" && typeof s?.tool === "string")
    .slice(0, MAX_SUBTASKS)
    .map((s, i) => ({ id: `st${i + 1}`, title: String(s.title).slice(0, 200), tool: String(s.tool).slice(0, 80), tier: tierOfTool(String(s.tool)), agent: workers[i % workers.length], status: "pending" as const }));
  return parsed.length ? parsed : base;
}

/** Pure criteria evaluation over the finished subtasks. */
export function evaluateCriteria(criteria: Criterion[], subs: Subtask[]): { id: string; kind: string; ok: boolean; detail?: string }[] {
  const ok = subs.filter((s) => s.status === "ok").length;
  const denied = subs.filter((s) => s.status === "denied").length;
  const failed = subs.length - ok;
  const text = subs.map((s) => s.output ?? "").join("\n").toLowerCase();
  return criteria.map((c) => {
    switch (c.kind) {
      case "all_subtasks_ok":
        return { id: c.id, kind: c.kind, ok: subs.length > 0 && ok === subs.length, detail: `${ok}/${subs.length}` };
      case "min_subtasks_ok":
        return { id: c.id, kind: c.kind, ok: ok >= Number(c.value ?? 1), detail: `${ok} ≥ ${c.value ?? 1}` };
      case "output_contains":
        return { id: c.id, kind: c.kind, ok: !!c.value && text.includes(String(c.value).toLowerCase()), detail: String(c.value ?? "") };
      case "no_denials":
        return { id: c.id, kind: c.kind, ok: denied === 0, detail: `${denied} denied` };
      case "max_failure_rate":
        return { id: c.id, kind: c.kind, ok: subs.length > 0 && failed / subs.length <= Number(c.value ?? 0), detail: `${failed}/${subs.length}` };
    }
  });
}

async function finishKilled(env: Env, s: SwarmState, scope: string): Promise<string> {
  s.outcome = "killed";
  s.stopped = `killed:${scope}`;
  s.phase = "done";
  await closeMission(env, s, `kill switch (${scope})`);
  return `kill switch (${scope}) — mission stopped and rolled back`;
}

/** Bring the mission row to a terminal state that matches the swarm outcome (fail → roll back). */
async function closeMission(env: Env, s: SwarmState, reason: string): Promise<void> {
  const m = await getMission(env, s.mission_id);
  if (!m) return;
  try {
    if (m.status === "running" || m.status === "verifying") await transitionMission(env, m.id, "failed", "army.swarm", { verdict: s.verdict ?? { reason } });
    const again = await getMission(env, m.id);
    if (again?.status === "failed") {
      await rollbackMission(env, m.id, reason, "army.swarm");
      if (s.outcome !== "killed") s.outcome = "rolled_back";
    }
  } catch (e) {
    if (!(e instanceof MissionError)) throw e;
  }
}

export const armyMissionJob: JobHandler<SwarmState> = {
  kind: ARMY_MISSION_KIND,
  async step(env, lab, _job, s) {
    s.steps++;
    const m = await getMission(env, s.mission_id);
    if (!m) {
      s.phase = "done";
      s.outcome = "failed";
      s.stopped = "mission_missing";
      return { message: "mission no longer exists" };
    }
    const c = m.contract;
    if (s.phase === "start") {
      const k = await armyKillCheck(env, { mission_id: m.id, division: c.division, agent_id: c.assigned_swarm.planner });
      if (k.killed) return { message: await finishKilled(env, s, k.scope!) };
      if (m.status !== "running") throw new Error(`mission is ${m.status}, expected running`);
      if (m.deadline <= Date.now()) {
        s.phase = "done";
        s.outcome = "failed";
        s.stopped = "deadline";
        await closeMission(env, s, "deadline passed");
        return { message: "deadline passed — rolled back" };
      }
      const root = await mintMissionRoot(env, m);
      s.root_token = root.token;
      s.phase = "plan";
      return { message: `root capability ${root.token_id} minted for ${c.assigned_swarm.planner}` };
    }
    if (s.phase === "plan") {
      const k = await armyKillCheck(env, { mission_id: m.id, division: c.division, agent_id: c.assigned_swarm.planner });
      if (k.killed) return { message: await finishKilled(env, s, k.scope!) };
      s.subtasks = await plan(env, lab, m);
      s.wi = 0;
      s.phase = s.subtasks.length ? "work" : "verify";
      await armyAudit(env.DB, `agent:${c.assigned_swarm.planner}`, "army.swarm.plan", m.id, { subtasks: s.subtasks.map((t) => ({ id: t.id, tool: t.tool, agent: t.agent })) });
      return { message: `planner wrote ${s.subtasks.length} subtasks` };
    }
    if (s.phase === "work") {
      const sub = s.subtasks[s.wi];
      const k = await armyKillCheck(env, { mission_id: m.id, division: c.division, agent_id: sub.agent });
      if (k.killed) return { message: await finishKilled(env, s, k.scope!) };
      // Attenuated worker token: same mission scope, fewer calls, short TTL.
      let workerToken: string;
      try {
        const minted = await mintCapability(
          env,
          { agent_id: sub.agent, mission_id: m.id, tools: c.scope.tools, max_tier: c.scope.max_tier, data_scopes: c.scope.data_scopes, egress: c.scope.egress, ttl_s: WORKER_TOKEN_TTL_S, max_calls: 4, spend_cap_usd: 0 },
          { actor: `agent:${c.assigned_swarm.planner}`, parent: s.root_token ?? undefined },
        );
        workerToken = minted.token;
        sub.token_id = minted.body.token_id;
      } catch (e) {
        sub.status = "failed";
        sub.reason = `token: ${String((e as Error).message).slice(0, 200)}`;
        workerToken = "";
      }
      if (workerToken) {
        const use = await useCapability(env, workerToken, { tool_id: sub.tool, tier: sub.tier, agent_id: sub.agent, mission_id: m.id, data_scope: sub.data_scope, egress_domain: sub.egress_domain });
        if (!use.ok) {
          sub.status = "denied";
          sub.reason = String(use.reason);
        } else {
          const res = await lab.complete(sub.agent, {
            messages: [{ role: "user", content: `You are a worker in an agent swarm. Do this subtask and report the result briefly.\nSUBTASK: ${sub.title}\nTOOL (simulated, already authorised): ${sub.tool}\nMISSION GOAL: ${c.goal}` }],
            temperature: 0,
            maxTokens: 500,
          });
          sub.status = "ok";
          sub.output = `${sub.title} [${sub.tool}, gateway: simulated] → ${res.text.slice(0, 600)}`;
        }
      }
      await armyAudit(env.DB, `agent:${sub.agent}`, "army.swarm.work", m.id, { subtask: sub.id, tool: sub.tool, status: sub.status, reason: sub.reason ?? null });
      s.wi++;
      const bad = s.subtasks.filter((t) => t.status === "denied" || t.status === "failed").length;
      if (bad / s.subtasks.length > BREAKER_RATIO) {
        s.phase = "done";
        s.outcome = "failed";
        s.stopped = "circuit_breaker";
        await armyAudit(env.DB, "army.swarm", "army.swarm.breaker", m.id, { failed: bad, total: s.subtasks.length });
        await closeMission(env, s, `circuit breaker: ${bad}/${s.subtasks.length} subtasks failed`);
        return { message: `circuit breaker tripped (${bad}/${s.subtasks.length}) — rolled back` };
      }
      if (s.wi >= s.subtasks.length) s.phase = "verify";
      return { message: `${sub.id} ${sub.status}${sub.reason ? ` (${sub.reason})` : ""}` };
    }
    if (s.phase === "verify") {
      const verifier = c.assigned_swarm.verifier;
      const k = await armyKillCheck(env, { mission_id: m.id, division: "quality", agent_id: verifier });
      if (k.killed) return { message: await finishKilled(env, s, k.scope!) };
      if (m.status === "running") await transitionMission(env, m.id, "verifying", "army.swarm");
      const criteria = evaluateCriteria(c.success_criteria, s.subtasks);
      const res = await lab.complete(verifier, {
        messages: [{ role: "user", content: `You verify another agent's work; you did not do it. Answer PASS or FAIL with one reason.\nGOAL: ${c.goal}\nRESULTS:\n${s.subtasks.map((t) => `- ${t.id} ${t.status}: ${(t.output ?? t.reason ?? "").slice(0, 300)}`).join("\n")}` }],
        temperature: 0,
        maxTokens: 200,
      });
      const llmFail = !isMock(env) && /^\s*FAIL\b/i.test(res.text);
      const pass = criteria.every((x) => x.ok) && !llmFail;
      s.verdict = { pass, criteria, verifier, llm_note: res.text.slice(0, 300) };
      s.phase = "done";
      if (pass) {
        await transitionMission(env, m.id, "done", `agent:${verifier}`, { verdict: s.verdict });
        s.outcome = "done";
        return { message: "verifier: PASS — mission done" };
      }
      s.outcome = "failed";
      await closeMission(env, s, "verifier: FAIL");
      return { message: "verifier: FAIL — rolled back" };
    }
    return { message: "nothing to do" };
  },
  isDone: (s) => s.phase === "done",
  progress: (s) => {
    const total = 3 + Math.max(1, s.subtasks.length);
    const done = s.phase === "done" ? total : s.phase === "start" ? 0 : s.phase === "plan" ? 1 : s.phase === "work" ? 2 + s.wi : 2 + s.subtasks.length;
    return { done, total };
  },
  result: (s) => ({ mission_id: s.mission_id, outcome: s.outcome, stopped: s.stopped, verdict: s.verdict, subtasks: s.subtasks.map(({ output, ...t }) => ({ ...t, output: output?.slice(0, 300) })) }),
  async onFinish(env, _job, s, end) {
    // Budget stop / cancel / failure before the swarm finished: never leave a mission "running".
    if (s.phase !== "done") {
      s.outcome = "failed";
      s.stopped = end.stopped ?? end.status;
      await closeMission(env, s, `job ended early: ${end.stopped ?? end.error ?? end.status}`);
    }
    await armyAudit(env.DB, "army.swarm", "army.swarm.finish", s.mission_id, { outcome: s.outcome, stopped: s.stopped, llm_calls: end.llm_calls, job_status: end.status });
  },
};

export const ARMY_JOB_HANDLERS: Record<string, JobHandler> = { [armyMissionJob.kind]: armyMissionJob };

/** Idempotently register the army job kind with the runner (until jobs/handlers.ts lists it explicitly). */
export function registerArmyJobs(): void {
  for (const [k, h] of Object.entries(ARMY_JOB_HANDLERS)) if (!HANDLERS[k]) HANDLERS[k] = h;
}

export function swarmInit(missionId: string): { state: SwarmState; total: number } {
  return { state: { mission_id: missionId, phase: "start", root_token: null, subtasks: [], wi: 0, steps: 0, outcome: null, stopped: null, verdict: null }, total: 4 };
}

/** approved → running, then enqueue the swarm job (owner-triggered). */
export async function startMission(env: Env, missionId: string, actor = "owner") {
  registerArmyJobs();
  const m = await getMission(env, missionId);
  if (!m) throw new MissionError("not_found", `mission ${missionId} not found`);
  const k = await armyKillCheck(env, { mission_id: m.id, division: m.contract.division, agent_id: m.contract.assigned_swarm.planner });
  if (k.killed) throw new MissionError("killed", `kill switch (${k.scope}) is ON`);
  await transitionMission(env, missionId, "running", actor);
  const init = swarmInit(missionId);
  const { job, reused } = await startJob(env, { kind: ARMY_MISSION_KIND, params: { mission_id: missionId }, state: init.state, total: init.total, max_calls: Math.max(3, m.contract.budget.llm_calls), dedupe_key: `${ARMY_MISSION_KIND}:${missionId}` });
  await env.DB.prepare("UPDATE army_missions SET job_id = ?2, updated_at = ?3 WHERE id = ?1").bind(missionId, job.id, Date.now()).run();
  return jobAccepted(job, reused);
}

export type { JobRow };
