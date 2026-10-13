/**
 * The agents' way into the Tool Forge: built-in tool `forge.submit` (T2 = sandboxed code, so Toolsmith / Builder
 * / Evaluator / Director may carry it). Like every T3/T4 tool it goes through the owner's approval queue:
 *   gateway → prepareApproval (structure pre-check, stage the spec as a `pending` forge row, compact approval
 *   args) → owner approves → handler starts the "forge.admit" job (sandboxed gates + Critic) → admitted tools
 *   show up in the gateway as forge.* tools (T1).
 * Owner rejection marks the staged row rejected. Sandboxed agents get a simulated result (no row, no approval).
 * NOTE: only tools/catalog.ts may import this module (it is part of the TOOLS array; see the import-order note).
 */
import { audit } from "../audit";
import type { ToolContext, ToolDef } from "../tools/catalog";
import { forgeAdmitInit, forgeAdmitKey, FORGE_ADMIT_CALLS, precheckSpec, stagePending } from "./jobs";
import { getTool, setPendingReason, setToolStatus } from "./store";
import type { ForgeToolSpec } from "./types";

async function lineageOf(c: ToolContext): Promise<string> {
  if (c.lineage) return c.lineage;
  const r = await c.env.DB.prepare("SELECT g.lineage_id AS l FROM agents a JOIN genomes g ON g.id = a.genome_id WHERE a.id = ?1")
    .bind(c.agentId)
    .first<{ l: string }>()
    .catch(() => null);
  return r?.l ?? `agent:${c.agentId}`;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Build the spec from the agent's args ({spec:{…}} or flat fields); author/lineage are always the caller's. */
export async function specFromArgs(c: ToolContext, a: Record<string, any>): Promise<ForgeToolSpec> {
  const src = (parseMaybeJson(a.spec) ?? a) as Record<string, unknown>;
  const spec: ForgeToolSpec = {
    name: String(src.name ?? ""),
    description: String(src.description ?? ""),
    input_schema: parseMaybeJson(src.input_schema) as ForgeToolSpec["input_schema"],
    code: String(src.code ?? ""),
    tests: parseMaybeJson(src.tests) as ForgeToolSpec["tests"],
    author: `agent:${c.agentId}`,
    lineage: await lineageOf(c),
  };
  if (src.output_schema !== undefined) spec.output_schema = parseMaybeJson(src.output_schema) as ForgeToolSpec["output_schema"];
  if (src.entry !== undefined) spec.entry = String(src.entry);
  if (src.limits !== undefined) spec.limits = parseMaybeJson(src.limits) as ForgeToolSpec["limits"];
  return spec;
}

export const forgeSubmitTool: ToolDef = {
  id: "forge.submit",
  name: "Submit a tool to the Forge",
  tier: 2,
  requiresApproval: true,
  description:
    "Propose a NEW sandboxed tool (QuickJS, no network): name forge.<area>.<verb>, description, input_schema (type object), optional output_schema, code declaring function run(input), and 1-20 tests [{input, expect}|{input, checker}]. Needs owner approval, then it must pass the Forge gates (tests, hidden adversarial tests, determinism, budget, critic of another lineage).",
  schema: {
    // fields are validated by the structure pre-check (flat fields or one {spec} object), not by the gateway's presence check
    required: [],
    properties: {
      spec: { type: "object", description: "alternative: the whole spec as one object" },
      name: { type: "string", description: "forge.<segment>[.<segment>…]" },
      description: { type: "string" },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      code: { type: "string", description: "guest JS declaring function run(input)" },
      entry: { type: "string" },
      tests: { type: "array" },
      limits: { type: "object" },
    },
  },
  async prepareApproval(c, a) {
    const spec = await specFromArgs(c, a);
    const pre = precheckSpec(spec);
    if (!pre.ok) throw new Error(pre.problems.slice(0, 4).join("; "));
    const { tool, decided } = await stagePending(c.env, spec);
    if (decided) return { immediate: { duplicate: true, tool_id: tool.id, name: tool.name, version: tool.version, status: tool.status, reason: tool.status_reason } };
    await setPendingReason(c.env, tool.id, `awaiting owner approval (submitted by agent:${c.agentId})`);
    return {
      args: { tool_id: tool.id, name: tool.name, version: tool.version, hash: tool.hash.slice(0, 16), description: spec.description.slice(0, 300), tests: spec.tests.length, code_bytes: spec.code.length },
      reason: `new forged tool ${tool.name} v${tool.version}`,
    };
  },
  async handler(c, a) {
    if (!c.approved) throw new Error("forge.submit requires owner approval");
    const tool = await getTool(c.env, String(a.tool_id ?? ""));
    if (!tool) throw new Error("staged tool not found");
    if (tool.status !== "pending") return { tool_id: tool.id, status: tool.status, note: "already decided" };
    const { startJob } = await import("../jobs/routes");
    const init = await forgeAdmitInit(c.env, tool, `agent:${c.agentId}`);
    const { job, reused } = await startJob(c.env, {
      kind: "forge.admit",
      params: { tool_id: tool.id, name: tool.name, version: tool.version, submitted_by: `agent:${c.agentId}`, approved: true },
      state: init.state,
      total: init.total,
      max_calls: FORGE_ADMIT_CALLS,
      dedupe_key: forgeAdmitKey(tool.id),
    });
    await setPendingReason(c.env, tool.id, `admission running (job ${job.id})`);
    return { tool_id: tool.id, name: tool.name, version: tool.version, job_id: job.id, reused, status: "admission_started" };
  },
  async onReject(env, a) {
    try {
      const tool = await getTool(env, String(a.tool_id ?? ""));
      if (tool && tool.status === "pending") {
        await setToolStatus(env, tool.id, "rejected", null, "owner rejected the submission");
        await audit(env.DB, "owner", "forge.rejected", tool.id, { name: tool.name, version: tool.version, reason: "owner rejected the submission" });
      }
    } catch (e) {
      console.error("forge.submit onReject failed", e);
    }
  },
};
