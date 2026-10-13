import { CONSTITUTION, type Role, type Tier } from "../constitution";
import { audit } from "../audit";
import { Governor, GovernorError } from "../governor/governor";
import { createApproval } from "../approvals";
import { TOOL_MAP, type ToolContext, type ToolDef } from "./catalog";
import { forgeToolDef, grantsTool } from "../forge/tool";
import { truncate } from "../util";

export type GatewayResult =
  | { status: "ok"; tool: string; tier: Tier; result: unknown }
  | { status: "pending_approval"; tool: string; tier: Tier; approval_id: string }
  | { status: "sandboxed"; tool: string; tier: Tier; result: unknown }
  | { status: "denied"; tool: string; reason: string }
  | { status: "error"; tool: string; tier: Tier; error: string };

export interface GatewayCaller extends ToolContext {
  genomeToolIds: string[];
}

/** Daily ledger for forged-tool sandbox runs (on top of tool_calls): half the org's daily tool calls, min 50. */
export const FORGE_RUN_SHARE = 0.5;

/** Built-in tool, or an admitted forged tool for a forge.* id. */
export async function resolveTool(env: GatewayCaller["env"], toolId: string): Promise<ToolDef | null> {
  return TOOL_MAP[toolId] ?? (toolId.startsWith("forge.") ? await forgeToolDef(env, toolId) : null);
}

/**
 * The ONLY path from an agent to a tool. Order: kill switch → known tool → genome grant →
 * role tier ceiling → arg check → budget debit → (approval queue | sandbox fake | execute) → audit.
 */
export class ToolGateway {
  private governor: Governor;
  constructor(private caller: GatewayCaller) {
    this.governor = new Governor(caller.env);
  }

  private async deny(tool: string, reason: string): Promise<GatewayResult> {
    await audit(this.caller.env.DB, `agent:${this.caller.agentId}`, "tool.denied", tool, { reason, run: this.caller.runId });
    return { status: "denied", tool, reason };
  }

  async call(toolId: string, args: Record<string, any> = {}): Promise<GatewayResult> {
    const c = this.caller;
    const actor = `agent:${c.agentId}`;
    await this.governor.assertMayContinue(c.agentId); // throws GovernorError("killed")

    if (CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => toolId.startsWith(p))) return this.deny(toolId, "forbidden_capability");
    const tool = await resolveTool(c.env, toolId);
    if (!tool) return this.deny(toolId, "unknown_tool");
    if (!grantsTool(c.genomeToolIds, toolId)) return this.deny(toolId, "not_in_genome");
    const forged = !TOOL_MAP[toolId];
    const maxTier = CONSTITUTION.roleMaxTier[c.role as Role] ?? 0;
    if (tool.tier > maxTier) return this.deny(toolId, `tier_exceeds_role (T${tool.tier} > T${maxTier})`);
    if (!args || typeof args !== "object" || Array.isArray(args)) return this.deny(toolId, "invalid_args");
    for (const req of tool.schema.required ?? []) if (args[req] === undefined || args[req] === null || args[req] === "") return this.deny(toolId, `missing_arg:${req}`);

    const debit = await this.governor.debit(c.agentId, "tool_calls", 1);
    if (!debit.ok) return this.deny(toolId, `budget_exhausted (${debit.scope})`);
    if (forged) {
      const caps = await this.governor.caps();
      const cap = Math.max(50, Math.floor(caps.global.tool_calls * FORGE_RUN_SHARE));
      if (!(await this.governor.debitOne("forge", "sandbox_runs", 1, cap))) {
        await this.governor.refund("global", "tool_calls", 1);
        await this.governor.refund(`agent:${c.agentId}`, "tool_calls", 1);
        return this.deny(toolId, "budget_exhausted (forge)");
      }
    }

    // Sandboxed agents never touch the outside world: external tiers (and owner-approval tools) get a fake result.
    if (c.sandboxed && (tool.tier >= 3 || tool.requiresApproval)) {
      const result = { mocked: true, note: `sandbox: ${toolId} simulated, no external effect` };
      await audit(c.env.DB, actor, "tool.sandboxed", toolId, { run: c.runId, args });
      return { status: "sandboxed", tool: toolId, tier: tool.tier, result };
    }

    if (CONSTITUTION.approvalTiers.includes(tool.tier) || tool.requiresApproval) {
      let stored: Record<string, unknown> = args;
      let reason: string | null = typeof args.reason === "string" ? args.reason : null;
      if (tool.prepareApproval) {
        let prep: Awaited<ReturnType<NonNullable<ToolDef["prepareApproval"]>>>;
        try {
          prep = await tool.prepareApproval(c, args);
        } catch (e) {
          if (e instanceof GovernorError) throw e;
          return this.deny(toolId, `invalid_args: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
        }
        if (prep.immediate !== undefined) {
          await audit(c.env.DB, actor, "tool.call", toolId, { run: c.runId, ok: true, immediate: true });
          return { status: "ok", tool: toolId, tier: tool.tier, result: prep.immediate };
        }
        stored = prep.args ?? args;
        reason = prep.reason ?? reason;
      }
      const id = await createApproval(c.env.DB, {
        agent_id: c.agentId,
        run_id: c.runId ?? null,
        tool_id: toolId,
        tier: tool.tier,
        args: stored,
        reason,
      });
      await audit(c.env.DB, actor, "approval.requested", id, { tool: toolId, tier: tool.tier, run: c.runId });
      return { status: "pending_approval", tool: toolId, tier: tool.tier, approval_id: id };
    }

    try {
      const result = await tool.handler(c, args);
      await audit(c.env.DB, actor, "tool.call", toolId, { run: c.runId, ok: true, args: truncate(JSON.stringify(args), 500) });
      return { status: "ok", tool: toolId, tier: tool.tier, result };
    } catch (e) {
      if (e instanceof GovernorError) throw e;
      const msg = String((e as Error)?.message ?? e);
      await audit(c.env.DB, actor, "tool.error", toolId, { run: c.runId, error: msg });
      return { status: "error", tool: toolId, tier: tool.tier, error: msg };
    }
  }
}
