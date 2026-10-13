/**
 * Tool Forge ↔ job runner: admission runs as job kind "forge.admit", one gate (or a few sandbox runs) per
 * chunk, so each invocation stays inside the free plan's CPU budget. LLM-backed gates (hidden adversarial
 * inputs from the Evaluator lineage, the Critic review) go through the job's LabLLM (kill switch → job call
 * budget → daily lab ledger → router caps). In mock mode a deterministic critic stands in.
 */
import { audit } from "../audit";
import type { Role } from "../constitution";
import type { Env } from "../env";
import type { LabLLM } from "../eval/llm";
import type { JobHandler } from "../jobs/handlers";
import { TOOL_MAP } from "../tools/catalog";
import { admissionInit, admissionProgress, admissionStep, llmAdversary, llmCritic, structureProblems, toolHash, type AdmissionCursor } from "./admission";
import { getTool, getToolByHash, insertPendingTool, recordForgeRun, setPendingReason, setToolStatus, specOf, type ForgeToolRow } from "./store";
import { forgeFuelCap } from "./tool";
import type { AdmissionDeps, Critic, ForgeToolSpec } from "./types";

export const FORGE_AGENT = "lab:forge";
/** LLM calls one admission may spend: hidden-input generation + critic, with one retry each. */
export const FORGE_ADMIT_CALLS = 6;
/** Sandbox runs per chunk on the free plan (≈ one small run per 10 ms invocation). */
export const FORGE_RUNS_PER_CHUNK = 1;

/** Names forged tools may never take (every built-in tool id, including forge.submit). */
export const reservedForgeNames = () => Object.keys(TOOL_MAP);

/** Patterns that make the deterministic (mock-mode) critic refuse a tool outright. */
const HIGH_RISK_WARNINGS = [/eval\(\)/, /Function\(\)/, /\.constructor/, /prototype tampering/, /globalThis/];

/** Deterministic critic for mock mode / no-LLM setups: refuses sandbox-escape patterns, approves the rest (low risk). */
export function mockForgeCritic(lineage: string): Critic {
  return {
    lineage,
    async review({ warnings }) {
      const bad = warnings.filter((w) => HIGH_RISK_WARNINGS.some((re) => re.test(w)));
      if (bad.length) return { approve: false, reason: `deterministic critic: ${bad.join("; ")}`, risk: "high" };
      return { approve: true, reason: warnings.length ? `deterministic critic: acceptable warnings (${warnings.length})` : "deterministic critic: no findings", risk: warnings.length ? "medium" : "low" };
    },
  };
}

/** Lineage of the current champion of a role (fallback: a stable synthetic id). */
export async function championLineage(env: Env, role: Role): Promise<string> {
  const r = await env.DB.prepare("SELECT lineage_id AS l FROM agents WHERE role = ?1 AND status = 'champion' ORDER BY updated_at DESC LIMIT 1")
    .bind(role)
    .first<{ l: string }>()
    .catch(() => null);
  return r?.l ?? `lin_${role}`;
}

/** Reviewer lineages for a submission: Critic reviews (Auditor when the author IS the Critic lineage); Evaluator writes hidden tests (Critic when the author is the Evaluator). */
export async function reviewerLineages(env: Env, authorLineage: string): Promise<{ critic: string; adversary: string }> {
  const [critic, auditor, evaluator] = await Promise.all([championLineage(env, "critic"), championLineage(env, "auditor"), championLineage(env, "evaluator")]);
  return { critic: critic === authorLineage ? auditor : critic, adversary: evaluator === authorLineage ? critic : evaluator };
}

export function admissionDeps(env: Env, lab: LabLLM, st: Pick<ForgeAdmitState, "critic_lineage" | "adversary_lineage">): AdmissionDeps {
  const base: AdmissionDeps = { reservedNames: reservedForgeNames(), fuelCap: forgeFuelCap(env) };
  if (lab.mode === "mock") return { ...base, critic: mockForgeCritic(st.critic_lineage) };
  const llm = (temperature: number, maxTokens: number) => async (prompt: string) =>
    (await lab.complete(FORGE_AGENT, { messages: [{ role: "user", content: prompt }], temperature, maxTokens })).text;
  return { ...base, critic: llmCritic(llm(0, 600), st.critic_lineage), adversary: llmAdversary(llm(0.7, 1200), st.adversary_lineage) };
}

// ---------------------------------------------------------------- job kind "forge.admit"
export interface ForgeAdmitState {
  tool_id: string;
  name: string;
  submitted_by: string;
  critic_lineage: string;
  adversary_lineage: string;
  /** Number of author tests (for progress). */
  tests: number;
  cursor: AdmissionCursor;
}

async function loadSpec(env: Env, toolId: string): Promise<{ row: ForgeToolRow; spec: ForgeToolSpec }> {
  const row = await getTool(env, toolId);
  if (!row) throw new Error(`forge tool ${toolId} disappeared`);
  return { row, spec: specOf(row) };
}

export const forgeAdmitJob: JobHandler<ForgeAdmitState> = {
  kind: "forge.admit",
  heavy: true, // one gate / FORGE_RUNS_PER_CHUNK sandbox runs per chunk
  async step(env, lab, _job, s) {
    const { row, spec } = await loadSpec(env, s.tool_id);
    if (row.status !== "pending") {
      // retired / decided elsewhere meanwhile: nothing left to admit
      s.cursor.phase = "done";
      s.cursor.report = row.report;
      return { message: `tool is already ${row.status}` };
    }
    const msg = await admissionStep(spec, s.cursor, admissionDeps(env, lab, s), FORGE_RUNS_PER_CHUNK);
    if (s.cursor.phase === "done" && s.cursor.report) {
      const report = s.cursor.report;
      await setToolStatus(env, row.id, report.status, report);
      await recordForgeRun(env, {
        tool_id: row.id,
        context: "admission",
        caller: spec.author,
        ok: report.status === "admitted",
        error_kind: report.status === "admitted" ? null : report.gates.find((g) => !g.pass && !g.skipped)?.gate ?? null,
        ms: report.stats.maxMs,
        fuel_used: report.stats.maxFuel,
        output_bytes: report.stats.maxOutputBytes,
      });
      await audit(env.DB, "system:forge", report.status === "admitted" ? "forge.admitted" : "forge.rejected", row.id, {
        name: row.name,
        version: row.version,
        author: row.author,
        reason: report.reason ?? null,
        runs: report.stats.runs,
        peak_fuel: report.stats.maxFuel,
      });
    }
    return { message: `${row.name} v${row.version}: ${msg}` };
  },
  isDone: (s) => s.cursor.phase === "done",
  progress: (s) => admissionProgress(s.tests, s.cursor),
  result: (s) => ({
    tool_id: s.tool_id,
    name: s.name,
    phase: s.cursor.phase,
    status: s.cursor.report?.status ?? "pending",
    reason: s.cursor.report?.reason ?? null,
    gates: s.cursor.gates.map((g) => ({ gate: g.gate, pass: g.pass, skipped: !!g.skipped, reason: g.reason ?? null })),
    warnings: s.cursor.warnings,
    stats: s.cursor.stats,
  }),
  async onFinish(env, _job, s, end) {
    if (end.status === "done" && s.cursor.report) return;
    // cancelled / failed / budget stop: the row stays pending (a resubmission restarts admission) with a note
    const why = end.stopped && end.stopped !== "cancelled" ? `stopped: ${end.stopped}` : end.status === "failed" ? `failed: ${String(end.error ?? "").slice(0, 160)}` : "cancelled";
    await setPendingReason(env, s.tool_id, `admission ${why}; resubmit to retry`);
    await audit(env.DB, "system:forge", "forge.admit_stopped", s.tool_id, { name: s.name, status: end.status, stopped: end.stopped ?? null, error: end.error ? String(end.error).slice(0, 200) : null });
  },
};

export const forgeAdmitKey = (toolId: string) => `forge.admit:${toolId}`;

export interface SubmitCheck {
  ok: boolean;
  problems: string[];
}

/** Synchronous pre-check (structure gate, no sandbox): junk never reaches the DB or the approval queue. */
export function precheckSpec(spec: ForgeToolSpec): SubmitCheck {
  const problems = structureProblems(spec, reservedForgeNames());
  return { ok: problems.length === 0, problems };
}

/**
 * Store a submission as `pending` (dedupe by content hash). Returns the row and whether an identical spec was
 * already decided (admitted / rejected / deprecated) — in that case no admission is needed.
 */
export async function stagePending(env: Env, spec: ForgeToolSpec): Promise<{ tool: ForgeToolRow; decided: boolean }> {
  const hash = await toolHash(spec);
  const existing = await getToolByHash(env, spec.name, hash);
  if (existing && existing.status !== "pending") return { tool: existing, decided: true };
  return { tool: existing ?? (await insertPendingTool(env, spec, hash)), decided: false };
}

/** Initial job state for a staged tool. */
export async function forgeAdmitInit(env: Env, tool: ForgeToolRow, submittedBy: string): Promise<{ state: ForgeAdmitState; total: number }> {
  const spec = specOf(tool);
  const lin = await reviewerLineages(env, spec.lineage);
  const cursor = await admissionInit(spec, { fuelCap: forgeFuelCap(env) });
  const tests = Array.isArray(spec.tests) ? spec.tests.length : 0;
  const total = admissionProgress(tests, cursor).total;
  return { state: { tool_id: tool.id, name: tool.name, submitted_by: submittedBy, critic_lineage: lin.critic, adversary_lineage: lin.adversary, tests, cursor }, total };
}
