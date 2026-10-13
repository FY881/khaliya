import { CONSTITUTION, type Tier } from "./constitution";
import { home } from "./home/stub";
import type { Env } from "./env";
import { audit } from "./audit";
import { TOOL_MAP } from "./tools/catalog";
import { newId, safeJsonParse, truncate } from "./util";

export interface ApprovalRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  tool_id: string;
  tier: number;
  args: string;
  reason: string | null;
  status: string;
  result: string | null;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

export async function createApproval(
  db: D1Database,
  a: { agent_id: string; run_id: string | null; tool_id: string; tier: Tier; args: unknown; reason: string | null },
): Promise<string> {
  const id = newId("apr");
  await db
    .prepare(
      "INSERT INTO approvals (id, agent_id, run_id, tool_id, tier, args, reason, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)",
    )
    .bind(id, a.agent_id, a.run_id, a.tool_id, a.tier, truncate(JSON.stringify(a.args ?? {}), 8000), a.reason, Date.now())
    .run();
  return id;
}

export async function listApprovals(db: D1Database, status?: string, limit = 100): Promise<ApprovalRow[]> {
  const q = status
    ? db.prepare("SELECT * FROM approvals WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2").bind(status, limit)
    : db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?1").bind(limit);
  return (await q.all<ApprovalRow>()).results;
}

export class ApprovalError extends Error {
  constructor(
    public code: "not_found" | "not_pending" | "step_up_required" | "not_owner",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Decide a pending approval. `actor` MUST be "owner" — this function is only reachable from
 * owner-authenticated routes; there is no agent tool for it (constitution art. 2/4).
 * T4 approvals require `stepUpOk` (a fresh TOTP verified by the caller).
 */
export async function decideApproval(
  env: Env,
  id: string,
  decision: "approve" | "reject",
  opts: { actor: string; stepUpOk?: boolean; note?: string },
): Promise<ApprovalRow> {
  if (opts.actor !== "owner") throw new ApprovalError("not_owner", "only the owner can decide approvals");
  const row = await env.DB.prepare("SELECT * FROM approvals WHERE id = ?1").bind(id).first<ApprovalRow>();
  if (!row) throw new ApprovalError("not_found", "approval not found");
  if (row.status !== "pending") throw new ApprovalError("not_pending", `approval is ${row.status}`);
  if (decision === "approve" && CONSTITUTION.stepUpTiers.includes(row.tier as Tier) && !opts.stepUpOk)
    throw new ApprovalError("step_up_required", "T4 approval needs a fresh TOTP code");

  // Claim atomically so a double click cannot execute twice.
  const claimed = await env.DB.prepare(
    "UPDATE approvals SET status = ?2, decided_by = 'owner', decided_at = ?3 WHERE id = ?1 AND status = 'pending' RETURNING id",
  )
    .bind(id, decision === "approve" ? "approved" : "rejected", Date.now())
    .first();
  if (!claimed) throw new ApprovalError("not_pending", "approval already decided");
  await audit(env.DB, "owner", decision === "approve" ? "approval.approved" : "approval.rejected", id, {
    tool: row.tool_id,
    tier: row.tier,
    note: opts.note,
  });

  if (decision === "reject") {
    const t = TOOL_MAP[row.tool_id];
    if (t?.onReject) await t.onReject(env, safeJsonParse<Record<string, unknown>>(row.args) ?? {});
  }
  let finalStatus = decision === "approve" ? "approved" : "rejected";
  let result: unknown = opts.note ? { note: opts.note } : null;
  if (decision === "approve") {
    const tool = TOOL_MAP[row.tool_id];
    try {
      if (!tool) throw new Error("tool no longer exists");
      const agent = await env.DB.prepare("SELECT role FROM agents WHERE id = ?1").bind(row.agent_id).first<{ role: string }>();
      result = await tool.handler(
        { env, agentId: row.agent_id, runId: row.run_id ?? undefined, role: agent?.role ?? "unknown", sandboxed: false, approved: true },
        safeJsonParse(row.args) ?? {},
      );
      finalStatus = "executed";
    } catch (e) {
      result = { error: String((e as Error)?.message ?? e) };
      finalStatus = "failed";
    }
    await audit(env.DB, "system", `approval.${finalStatus}`, id, { tool: row.tool_id });
  }
  await env.DB.prepare("UPDATE approvals SET status = ?2, result = ?3 WHERE id = ?1")
    .bind(id, finalStatus, result === null ? null : truncate(JSON.stringify(result), 8000))
    .run();

  // Let the requesting agent know (its inbox), best effort.
  try {
    const stub = home(env, row.agent_id);
    await stub.deliver("owner", `Approval ${id} for ${row.tool_id}: ${finalStatus}. ${truncate(JSON.stringify(result ?? {}), 1500)}`);
  } catch {}

  return (await env.DB.prepare("SELECT * FROM approvals WHERE id = ?1").bind(id).first<ApprovalRow>())!;
}
