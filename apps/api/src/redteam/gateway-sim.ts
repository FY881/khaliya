/**
 * Simulated Tool Gateway for the arena. It applies the SAME policy order as src/tools/gateway.ts
 * (forbidden prefix → known tool → genome grant → role tier ceiling → args → run cap → approval tiers) but it
 * never calls a tool handler, never debits the Governor's ledgers, never creates approval rows and never writes the
 * audit log. Every attempted call becomes a TraceAction so detectors can see what the target TRIED, and what the
 * real gateway would have done with it.
 */
import { CONSTITUTION, type Role } from "../constitution";
import { FORGE_TIER, grantsTool } from "../forge/tool";
import { TOOL_MAP } from "../tools/catalog";
import type { ManifestTool, TraceAction } from "./types";

export interface SimTarget {
  role: string;
  tool_ids: string[];
  budget_profile?: { max_tool_calls?: number };
}

export interface SimState {
  /** Calls that passed the policy checks and were counted against the run cap. */
  counted: number;
  cap: number;
}

export function newSimState(t: SimTarget): SimState {
  const hard = CONSTITUTION.runHardCaps.max_tool_calls;
  const want = t.budget_profile?.max_tool_calls ?? CONSTITUTION.runDefaultCaps.max_tool_calls;
  return { counted: 0, cap: Math.max(1, Math.min(hard, Math.floor(Number(want) || hard))) };
}

export const isForbiddenTool = (toolId: string) => CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => toolId.startsWith(p));

interface Resolved {
  tier: number;
  required: string[];
  approval: boolean;
}

function resolve(toolId: string, manifest: ManifestTool[]): Resolved | null {
  const def = TOOL_MAP[toolId];
  if (def) return { tier: def.tier, required: def.schema.required ?? [], approval: !!def.requiresApproval };
  // A forged tool shown in the scenario's manifest. Real forged tools are always FORGE_TIER, whatever they claim.
  if (toolId.startsWith("forge.") && manifest.some((m) => m.id === toolId)) return { tier: FORGE_TIER, required: [], approval: false };
  return null;
}

export function simulateCall(t: SimTarget, manifest: ManifestTool[], tool: string, args: unknown, st: SimState): TraceAction {
  const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const deny = (reason: string, tier?: number): TraceAction => ({ tool, args: a, decision: "denied", reason, tier });
  if (typeof tool !== "string" || !tool) return deny("invalid_tool_id");
  if (isForbiddenTool(tool)) return deny("forbidden_capability");
  const r = resolve(tool, manifest);
  if (!r) return deny("unknown_tool");
  if (!grantsTool(t.tool_ids, tool)) return deny("not_in_genome", r.tier);
  const maxTier = CONSTITUTION.roleMaxTier[t.role as Role] ?? 0;
  if (r.tier > maxTier) return deny(`tier_exceeds_role (T${r.tier} > T${maxTier})`, r.tier);
  if (args !== undefined && a !== args) return deny("invalid_args", r.tier);
  for (const req of r.required) if (a[req] === undefined || a[req] === null || a[req] === "") return deny(`missing_arg:${req}`, r.tier);
  if (st.counted >= st.cap) return deny("run_cap_reached", r.tier);
  st.counted++;
  if (CONSTITUTION.approvalTiers.includes(r.tier as 3 | 4) || r.approval)
    return { tool, args: a, decision: "sandboxed", reason: "simulated: outside the sandbox this goes to the owner's approval queue", tier: r.tier };
  return { tool, args: a, decision: "ok_simulated", reason: "simulated: the real gateway would execute this (internal effect)", tier: r.tier };
}

/** Simulated observation returned to a target for an allowed call (never real data). */
export function simulatedResult(a: TraceAction): string {
  if (a.decision === "denied") return `denied: ${a.reason}`;
  return JSON.stringify({ mocked: true, note: `sandbox: ${a.tool} simulated, no external effect` });
}
