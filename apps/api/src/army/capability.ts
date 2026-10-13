/**
 * Capability tokens (master plan §2.4). No agent holds a standing permission: each mission/worker gets a short-lived,
 * signed, scoped token. Scope = tool ids (exact or "prefix.*"), max tier (+ optional explicit tier set), data scopes,
 * egress domains; limits = TTL, max calls, spend cap (default 0 — anything above 0 needs the two-key rule).
 * A child token can only be NARROWER than its parent (attenuation, macaroon style).
 *
 *   checkCapability(token, action, ctx)  — PURE, synchronous; the ToolGateway can call it later.
 *   useCapability(env, raw, action)      — verify signature + revocation list + atomic call counter + checkCapability;
 *                                          an out-of-scope use auto-revokes the token (and its children) and records a
 *                                          scope_violation incident.
 */
import { CONSTITUTION, type Tier } from "../constitution";
import type { Env } from "../env";
import { newId } from "../util";
import { armyAudit } from "./audit";
import { type ApprovalKey, checkApprovals, requiredApprovals } from "./autonomy";
import { ArmyCryptoError, armySecret, signDoc, verifyDoc } from "./crypto";
import { effectiveTierCap, isDivision } from "./divisions";
import { recordIncident } from "./ranks";

export const CAP_PREFIX = "kc1";
export const CAP_DEFAULT_TTL_S = 900;
export const CAP_MAX_TTL_S = 24 * 3600;
export const CAP_MAX_CALLS = 1000;

export interface CapabilityBody {
  v: 1;
  token_id: string;
  agent_id: string;
  mission_id: string | null;
  parent_id: string | null;
  tools: string[];
  max_tier: Tier;
  /** Optional explicit tier allow-list (each ≤ max_tier). Empty = every tier ≤ max_tier. */
  tiers: Tier[];
  data_scopes: string[];
  egress: string[];
  iat: number;
  exp: number;
  max_calls: number;
  spend_cap_usd: number;
}

export interface CapabilityAction {
  tool_id: string;
  tier: Tier;
  agent_id?: string;
  mission_id?: string;
  data_scope?: string;
  egress_domain?: string;
  spend_usd?: number;
}

export interface CapabilityCtx {
  now?: number;
  calls_used?: number;
  spent_usd?: number;
  revoked?: ReadonlySet<string> | readonly string[];
}

export type CapReason =
  | "revoked"
  | "expired"
  | "not_yet_valid"
  | "max_calls"
  | "wrong_agent"
  | "wrong_mission"
  | "forbidden_capability"
  | "tool_not_allowed"
  | "tier_exceeded"
  | "tier_not_allowed"
  | "data_scope_denied"
  | "egress_denied"
  | "spend_cap";

export type CapCheck = { ok: true } | { ok: false; reason: CapReason; violation: boolean };

/** Reasons that mean the agent tried to act outside its grant (auto-revoke + security incident). */
export const VIOLATIONS: ReadonlySet<CapReason> = new Set<CapReason>(["wrong_agent", "wrong_mission", "forbidden_capability", "tool_not_allowed", "tier_exceeded", "tier_not_allowed", "data_scope_denied", "egress_denied", "spend_cap"]);

export function toolMatches(pattern: string, toolId: string): boolean {
  if (pattern === toolId) return true;
  if (pattern.endsWith(".*")) return toolId.startsWith(pattern.slice(0, -1));
  return false;
}

export function domainMatches(pattern: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return d.endsWith(p.slice(1)) && d.length > p.length - 1;
  return d === p;
}

/** A grant pattern that names, or could expand into, a forbidden capability. */
const isForbidden = (id: string) => CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => id.startsWith(p) || (id.endsWith(".*") && p.startsWith(id.slice(0, -1))));

/** Child tool pattern covered by a parent pattern. */
export function toolCovered(child: string, parent: string): boolean {
  if (child.endsWith(".*")) return parent.endsWith(".*") && child.startsWith(parent.slice(0, -1));
  return toolMatches(parent, child);
}

/** Child egress pattern covered by a parent pattern. */
export function egressCovered(child: string, parent: string): boolean {
  if (child === parent) return true;
  if (child.startsWith("*.")) return parent.startsWith("*.") && child.slice(1).endsWith(parent.slice(1));
  return domainMatches(parent, child);
}

/** PURE capability check. No I/O, no clock unless ctx.now is omitted. */
export function checkCapability(token: CapabilityBody, action: CapabilityAction, ctx: CapabilityCtx = {}): CapCheck {
  const now = ctx.now ?? Date.now();
  const deny = (reason: CapReason): CapCheck => ({ ok: false, reason, violation: VIOLATIONS.has(reason) });
  const revoked = ctx.revoked ? (Array.isArray(ctx.revoked) ? new Set(ctx.revoked) : (ctx.revoked as ReadonlySet<string>)) : null;
  if (revoked && (revoked.has(token.token_id) || (token.parent_id && revoked.has(token.parent_id)))) return deny("revoked");
  if (now < token.iat - 5_000) return deny("not_yet_valid");
  if (now >= token.exp) return deny("expired");
  if (action.agent_id && action.agent_id !== token.agent_id) return deny("wrong_agent");
  if (action.mission_id && token.mission_id && action.mission_id !== token.mission_id) return deny("wrong_mission");
  if (CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => action.tool_id.startsWith(p))) return deny("forbidden_capability");
  if (!token.tools.some((p) => toolMatches(p, action.tool_id))) return deny("tool_not_allowed");
  if (action.tier > token.max_tier) return deny("tier_exceeded");
  if (token.tiers.length && !token.tiers.includes(action.tier)) return deny("tier_not_allowed");
  if (action.data_scope !== undefined && !token.data_scopes.includes(action.data_scope)) return deny("data_scope_denied");
  if (action.egress_domain !== undefined && !token.egress.some((p) => domainMatches(p, action.egress_domain!))) return deny("egress_denied");
  const spend = Math.max(0, Number(action.spend_usd ?? 0));
  if (spend > 0 && (ctx.spent_usd ?? 0) + spend > token.spend_cap_usd) return deny("spend_cap");
  if ((ctx.calls_used ?? 0) >= token.max_calls) return deny("max_calls");
  return { ok: true };
}

/** Is `child` a valid attenuation of `parent` (every dimension equal or narrower)? Returns the violations. */
export function narrowerThan(child: Omit<CapabilityBody, "token_id" | "v">, parent: CapabilityBody, parentCallsUsed = 0): string[] {
  const out: string[] = [];
  if (child.agent_id !== parent.agent_id && !child.mission_id) out.push("agent change without a mission");
  if (parent.mission_id && child.mission_id !== parent.mission_id) out.push("mission must stay the same");
  for (const t of child.tools) if (!parent.tools.some((p) => toolCovered(t, p))) out.push(`tool ${t} not in parent`);
  if (child.max_tier > parent.max_tier) out.push("max_tier wider than parent");
  if (parent.tiers.length && (child.tiers.length === 0 || child.tiers.some((t) => !parent.tiers.includes(t)))) out.push("tiers wider than parent");
  for (const d of child.data_scopes) if (!parent.data_scopes.includes(d)) out.push(`data scope ${d} not in parent`);
  for (const e of child.egress) if (!parent.egress.some((p) => egressCovered(e, p))) out.push(`egress ${e} not in parent`);
  if (child.exp > parent.exp) out.push("outlives parent");
  if (child.max_calls > Math.max(0, parent.max_calls - parentCallsUsed)) out.push("more calls than parent has left");
  if (child.spend_cap_usd > parent.spend_cap_usd) out.push("spend cap above parent");
  return out;
}

export class CapabilityError extends Error {
  constructor(public code: "bad_request" | "two_key_required" | "not_narrower" | "parent_invalid" | "tier_cap", message: string, public details?: string[]) {
    super(message);
  }
}

export interface CapabilitySpec {
  agent_id: string;
  mission_id?: string | null;
  tools: string[];
  max_tier?: Tier;
  tiers?: Tier[];
  data_scopes?: string[];
  egress?: string[];
  ttl_s?: number;
  max_calls?: number;
  spend_cap_usd?: number;
}

const strs = (v: unknown, max = 64) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((s) => s.trim()))].slice(0, max) : []);
const tierOf = (n: unknown): Tier | null => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 4 ? (n as Tier) : null);

/** Validate + normalise a spec into a body (no signing, no I/O). */
export function buildCapabilityBody(spec: CapabilitySpec, nowMs = Date.now(), parent?: CapabilityBody | null): CapabilityBody {
  if (!spec || typeof spec.agent_id !== "string" || !spec.agent_id) throw new CapabilityError("bad_request", "agent_id is required");
  const tools = strs(spec.tools);
  if (!tools.length) throw new CapabilityError("bad_request", "at least one tool id is required");
  const bad = tools.filter(isForbidden);
  if (bad.length) throw new CapabilityError("bad_request", `forbidden capability: ${bad.join(", ")}`);
  if (tools.includes("*") || tools.includes(".*")) throw new CapabilityError("bad_request", "wildcard-all tools are not allowed");
  const max_tier = tierOf(spec.max_tier ?? 1);
  if (max_tier === null) throw new CapabilityError("bad_request", "max_tier must be 0..4");
  const tiers = (Array.isArray(spec.tiers) ? spec.tiers : []).map(tierOf).filter((t): t is Tier => t !== null && t <= max_tier);
  const ttl = Math.floor(Number(spec.ttl_s ?? CAP_DEFAULT_TTL_S));
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > CAP_MAX_TTL_S) throw new CapabilityError("bad_request", `ttl_s must be 1..${CAP_MAX_TTL_S}`);
  const max_calls = Math.floor(Number(spec.max_calls ?? 40));
  if (!Number.isFinite(max_calls) || max_calls < 1 || max_calls > CAP_MAX_CALLS) throw new CapabilityError("bad_request", `max_calls must be 1..${CAP_MAX_CALLS}`);
  const spend = Number(spec.spend_cap_usd ?? 0);
  if (!Number.isFinite(spend) || spend < 0) throw new CapabilityError("bad_request", "spend_cap_usd must be ≥ 0");
  const data_scopes = strs(spec.data_scopes);
  if (data_scopes.includes("*")) throw new CapabilityError("bad_request", "data scope '*' is not allowed (per-tenant isolation)");
  const egress = strs(spec.egress).map((d) => d.toLowerCase());
  if (egress.some((d) => d === "*" || d.includes("/") || d.includes(":"))) throw new CapabilityError("bad_request", "egress entries are bare domains or *.domain");
  let exp = nowMs + ttl * 1000;
  if (parent) exp = Math.min(exp, parent.exp);
  return { v: 1, token_id: newId("cap"), agent_id: spec.agent_id, mission_id: spec.mission_id ?? parent?.mission_id ?? null, parent_id: parent?.token_id ?? null, tools, max_tier, tiers: [...new Set(tiers)].sort(), data_scopes, egress, iat: nowMs, exp, max_calls, spend_cap_usd: spend };
}

export const signCapability = (secret: string | undefined, body: CapabilityBody) => signDoc(secret, "capability", CAP_PREFIX, body);

export async function verifyCapabilitySig(secret: string | undefined, token: string): Promise<{ ok: true; body: CapabilityBody } | { ok: false; reason: string }> {
  try {
    const body = await verifyDoc<CapabilityBody>(secret, "capability", CAP_PREFIX, token);
    if (body.v !== 1 || !Array.isArray(body.tools)) return { ok: false, reason: "malformed" };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, reason: e instanceof ArmyCryptoError ? e.code : "malformed" };
  }
}

export interface MintOpts {
  actor?: string;
  /** Required when spend_cap_usd > 0: owner (step-up) + second key, per the two-key rule. */
  keys?: ApprovalKey[];
  /** Signed parent token: the new token must be narrower. */
  parent?: string;
  nowMs?: number;
}

/** Mint, sign, persist and audit a capability token. Returns the signed string and its body. */
export async function mintCapability(env: Env, spec: CapabilitySpec, opts: MintOpts = {}): Promise<{ token: string; body: CapabilityBody }> {
  const nowMs = opts.nowMs ?? Date.now();
  let parent: CapabilityBody | null = null;
  let parentUsed = 0;
  if (opts.parent) {
    const pv = await verifyCapabilitySig(armySecret(env), opts.parent);
    if (!pv.ok) throw new CapabilityError("parent_invalid", `parent token invalid: ${pv.reason}`);
    const prow = await env.DB.prepare("SELECT calls_used, revoked_at FROM army_capabilities WHERE id = ?1").bind(pv.body.token_id).first<{ calls_used: number; revoked_at: number | null }>();
    if (!prow || prow.revoked_at || pv.body.exp <= nowMs) throw new CapabilityError("parent_invalid", "parent token is unknown, revoked or expired");
    parent = pv.body;
    parentUsed = prow.calls_used;
  }
  const body = buildCapabilityBody(spec, nowMs, parent);
  if (parent) {
    const v = narrowerThan(body, parent, parentUsed);
    if (v.length) throw new CapabilityError("not_narrower", "child token must be narrower than its parent", v);
  }
  // Rank/division tier ceiling when the agent is known to the army.
  const rank = await env.DB.prepare("SELECT r.division, a.role FROM army_ranks r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.agent_id = ?1").bind(body.agent_id).first<{ division: string; role: string | null }>();
  if (rank?.role && isDivision(rank.division)) {
    const cap = effectiveTierCap(rank.role, rank.division);
    if (body.max_tier > cap) throw new CapabilityError("tier_cap", `max_tier T${body.max_tier} exceeds the agent's ceiling T${cap}`);
  }
  if (body.spend_cap_usd > 0) {
    const req = requiredApprovals("money", 4, "L0");
    const chk = checkApprovals(req, opts.keys ?? [], { id: body.agent_id });
    if (!chk.satisfied) throw new CapabilityError("two_key_required", "spend_cap_usd > 0 needs the two-key rule", chk.missing);
  }
  const token = await signCapability(armySecret(env), body);
  await env.DB.prepare(
    `INSERT INTO army_capabilities (id, agent_id, mission_id, parent_id, spec, max_calls, calls_used, spend_cap_usd, issued_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)`,
  )
    .bind(body.token_id, body.agent_id, body.mission_id, body.parent_id, JSON.stringify(body), body.max_calls, body.spend_cap_usd, body.iat, body.exp)
    .run();
  await armyAudit(env.DB, opts.actor ?? "owner", "army.cap.mint", body.token_id, { agent: body.agent_id, mission: body.mission_id, parent: body.parent_id, tools: body.tools, max_tier: body.max_tier, ttl_s: Math.round((body.exp - body.iat) / 1000), max_calls: body.max_calls, spend_cap_usd: body.spend_cap_usd });
  return { token, body };
}

/** Revoke a token and every descendant. Returns how many rows changed. */
export async function revokeCapability(env: Env, tokenId: string, reason: string, actor = "owner"): Promise<number> {
  const ts = Date.now();
  let frontier = [tokenId];
  let total = 0;
  const seen = new Set<string>();
  for (let depth = 0; frontier.length && depth < 16; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const r = await env.DB.prepare("UPDATE army_capabilities SET revoked_at = ?2, revoke_reason = ?3 WHERE id = ?1 AND revoked_at IS NULL").bind(id, ts, reason.slice(0, 200)).run();
      total += r.meta?.changes ?? 0;
      const kids = (await env.DB.prepare("SELECT id FROM army_capabilities WHERE parent_id = ?1").bind(id).all<{ id: string }>()).results;
      next.push(...kids.map((k) => k.id));
    }
    frontier = next;
  }
  if (total) await armyAudit(env.DB, actor, "army.cap.revoke", tokenId, { reason, revoked: total });
  return total;
}

/** The revocation list: ids of revoked tokens that have not expired yet (expired ones fail on exp anyway). */
export async function revocationList(env: Env, nowMs = Date.now()): Promise<string[]> {
  return (await env.DB.prepare("SELECT id FROM army_capabilities WHERE revoked_at IS NOT NULL AND expires_at > ?1").bind(nowMs).all<{ id: string }>()).results.map((r) => r.id);
}

export async function listCapabilities(env: Env, opts: { agent_id?: string; mission_id?: string; live?: boolean; limit?: number } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.agent_id) where.push(`agent_id = ?${args.push(opts.agent_id)}`);
  if (opts.mission_id) where.push(`mission_id = ?${args.push(opts.mission_id)}`);
  if (opts.live) where.push(`revoked_at IS NULL AND expires_at > ?${args.push(Date.now())}`);
  const lim = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const rows = (await env.DB.prepare(`SELECT * FROM army_capabilities ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY issued_at DESC LIMIT ${lim}`).bind(...args).all<any>()).results;
  return rows.map((r) => ({ ...r, spec: JSON.parse(r.spec) as CapabilityBody }));
}

export type UseResult = { ok: true; token_id: string; calls_used: number } | { ok: false; reason: CapReason | string; token_id?: string; revoked?: boolean };

/**
 * Enforcing path: signature → D1 row (revoked?) → pure check → atomic call debit. Every use is audited; an
 * out-of-scope use revokes the token tree and records a scope_violation incident against the agent.
 */
export async function useCapability(env: Env, raw: string, action: CapabilityAction, opts: { actor?: string; nowMs?: number } = {}): Promise<UseResult> {
  const v = await verifyCapabilitySig(armySecret(env), raw);
  if (!v.ok) {
    await armyAudit(env.DB, opts.actor ?? "system", "army.cap.reject", null, { reason: v.reason, tool: action.tool_id });
    return { ok: false, reason: v.reason };
  }
  const b = v.body;
  const row = await env.DB.prepare("SELECT calls_used, revoked_at, parent_id FROM army_capabilities WHERE id = ?1").bind(b.token_id).first<{ calls_used: number; revoked_at: number | null; parent_id: string | null }>();
  if (!row) return { ok: false, reason: "unknown", token_id: b.token_id };
  const actor = opts.actor ?? `agent:${b.agent_id}`;
  const revoked = row.revoked_at ? [b.token_id] : [];
  const chk = checkCapability(b, action, { now: opts.nowMs, calls_used: row.calls_used, revoked });
  if (!chk.ok) {
    let didRevoke = false;
    if (chk.violation) {
      didRevoke = (await revokeCapability(env, b.token_id, `auto: ${chk.reason}`, "army.guard")) > 0;
      await recordIncident(env, b.agent_id, "scope_violation", 2, { token: b.token_id, tool: action.tool_id, reason: chk.reason }, "army.guard");
    }
    await armyAudit(env.DB, actor, chk.violation ? "army.cap.violation" : "army.cap.deny", b.token_id, { tool: action.tool_id, tier: action.tier, reason: chk.reason });
    return { ok: false, reason: chk.reason, token_id: b.token_id, revoked: didRevoke };
  }
  const r = await env.DB.prepare("UPDATE army_capabilities SET calls_used = calls_used + 1 WHERE id = ?1 AND revoked_at IS NULL AND calls_used < max_calls RETURNING calls_used").bind(b.token_id).first<{ calls_used: number }>();
  if (!r) {
    await armyAudit(env.DB, actor, "army.cap.deny", b.token_id, { tool: action.tool_id, reason: "max_calls" });
    return { ok: false, reason: "max_calls", token_id: b.token_id };
  }
  await armyAudit(env.DB, actor, "army.cap.use", b.token_id, { tool: action.tool_id, tier: action.tier, n: r.calls_used });
  return { ok: true, token_id: b.token_id, calls_used: r.calls_used };
}
