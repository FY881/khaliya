/**
 * Agent passports (master plan §2.3): a signed identity document per agent — HMAC-SHA256 keyed from SESSION_SECRET
 * (purpose "passport"). Carries genome hash, lineage, rank, division, allowed autonomy level (capped by rank, never
 * L5), red-team score and issue/expiry (30 days). The signed string is handed to the caller; D1 keeps only its hash
 * plus the fields needed for listing and revocation. Verification = signature + expiry + not revoked (+ optional
 * live check that the agent still runs the same genome).
 */
import type { Env } from "../env";
import { canonicalJson, newId, sha256Hex } from "../util";
import { armyAudit } from "./audit";
import { type AutonomyLevel, isAutonomy, levelNum, minLevel } from "./autonomy";
import { ArmyCryptoError, armySecret, signDoc, verifyDoc } from "./crypto";
import { type DivisionId } from "./divisions";
import { getRankRow, RANK_MAP, type Rank } from "./ranks";

export const PASSPORT_PREFIX = "kp1";
export const PASSPORT_TTL_MS = 30 * 86_400_000;

export interface PassportBody {
  v: 1;
  passport_id: string;
  agent_id: string;
  genome_id: string | null;
  genome_hash: string;
  lineage: { lineage_id: string | null; parent_ids: string[]; version: number | null };
  rank: Rank;
  division: DivisionId;
  autonomy: AutonomyLevel;
  redteam_score: number | null;
  iat: number;
  exp: number;
}

export class PassportError extends Error {
  constructor(public code: "not_found" | "bad_request" | "l5_forbidden", message: string) {
    super(message);
  }
}

/** Pure-ish: sign a passport body (no D1). */
export const signPassport = (secret: string | undefined, body: PassportBody) => signDoc(secret, "passport", PASSPORT_PREFIX, body);

export type PassportVerdict = { ok: true; passport: PassportBody } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "revoked" | "unknown" | "genome_changed" | "no_secret"; passport?: PassportBody };

/** Signature + expiry only (no D1). */
export async function verifyPassportSig(secret: string | undefined, token: string, nowMs = Date.now()): Promise<PassportVerdict> {
  let body: PassportBody;
  try {
    body = await verifyDoc<PassportBody>(secret, "passport", PASSPORT_PREFIX, token);
  } catch (e) {
    return { ok: false, reason: e instanceof ArmyCryptoError ? e.code === "no_secret" ? "no_secret" : e.code : "malformed" };
  }
  if (body.v !== 1 || typeof body.exp !== "number" || !isAutonomy(body.autonomy)) return { ok: false, reason: "malformed" };
  if (body.exp <= nowMs) return { ok: false, reason: "expired", passport: body };
  return { ok: true, passport: body };
}

async function genomeFacts(env: Env, agentId: string) {
  const a = await env.DB.prepare("SELECT a.genome_id, a.lineage_id, g.body, g.version, g.parent_ids FROM agents a LEFT JOIN genomes g ON g.id = a.genome_id WHERE a.id = ?1")
    .bind(agentId)
    .first<{ genome_id: string; lineage_id: string; body: string | null; version: number | null; parent_ids: string | null }>();
  if (!a) return null;
  return {
    genome_id: a.genome_id,
    genome_hash: await sha256Hex(a.body ? canonicalJson(JSON.parse(a.body)) : `genome:${a.genome_id}`),
    lineage: { lineage_id: a.lineage_id, parent_ids: a.parent_ids ? (JSON.parse(a.parent_ids) as string[]) : [], version: a.version },
  };
}

async function redteamScore(env: Env, genomeId: string | null): Promise<number | null> {
  if (!genomeId) return null;
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN breach = 0 THEN 1 ELSE 0 END) AS ok FROM redteam_results WHERE genome_id = ?1").bind(genomeId).first<{ n: number; ok: number | null }>();
    return r && r.n > 0 ? Math.round(((r.ok ?? 0) / r.n) * 1000) / 1000 : null;
  } catch {
    return null;
  }
}

export interface IssuedPassport {
  token: string;
  passport: PassportBody;
}

/**
 * Issue a passport for an existing agent. Autonomy = min(requested, rank ceiling); L5 is refused (it is a
 * per-mission owner grant, see missions.ts). Older live passports of the agent are superseded (revoked).
 */
export async function issuePassport(env: Env, agentId: string, opts: { autonomy?: AutonomyLevel; actor?: string; ttl_ms?: number; nowMs?: number } = {}): Promise<IssuedPassport> {
  if (opts.autonomy === "L5") throw new PassportError("l5_forbidden", "L5 is never carried by a passport; the owner grants it per mission");
  const facts = await genomeFacts(env, agentId);
  if (!facts) throw new PassportError("not_found", `agent ${agentId} not found`);
  const rank = (await getRankRow(env, agentId))!;
  const ceiling = RANK_MAP[rank.rank].max_autonomy;
  const autonomy = opts.autonomy && isAutonomy(opts.autonomy) ? minLevel(opts.autonomy, ceiling) : ceiling;
  const iat = opts.nowMs ?? Date.now();
  const ttl = Math.min(Math.max(60_000, opts.ttl_ms ?? PASSPORT_TTL_MS), PASSPORT_TTL_MS);
  const body: PassportBody = {
    v: 1,
    passport_id: newId("pp"),
    agent_id: agentId,
    genome_id: facts.genome_id,
    genome_hash: facts.genome_hash,
    lineage: facts.lineage,
    rank: rank.rank,
    division: rank.division,
    autonomy,
    redteam_score: await redteamScore(env, facts.genome_id),
    iat,
    exp: iat + ttl,
  };
  const token = await signPassport(armySecret(env), body);
  await env.DB.prepare("UPDATE army_passports SET revoked_at = ?2, revoke_reason = 'superseded' WHERE agent_id = ?1 AND revoked_at IS NULL").bind(agentId, iat).run();
  await env.DB.prepare(
    `INSERT INTO army_passports (id, agent_id, genome_id, genome_hash, lineage_id, rank, division, autonomy, redteam_score, token_hash, issued_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(body.passport_id, agentId, body.genome_id, body.genome_hash, body.lineage.lineage_id, body.rank, body.division, body.autonomy, body.redteam_score, await sha256Hex(token), body.iat, body.exp)
    .run();
  await armyAudit(env.DB, opts.actor ?? "owner", "army.passport.issue", agentId, { passport_id: body.passport_id, rank: body.rank, division: body.division, autonomy, exp: body.exp });
  return { token, passport: body };
}

/** Full verification: signature, expiry, D1 record (exists, hash matches, not revoked), optional live genome check. */
export async function verifyPassport(env: Env, token: string, opts: { checkGenome?: boolean; nowMs?: number } = {}): Promise<PassportVerdict> {
  const v = await verifyPassportSig(armySecret(env), token, opts.nowMs);
  if (!v.ok) return v;
  const row = await env.DB.prepare("SELECT token_hash, revoked_at FROM army_passports WHERE id = ?1").bind(v.passport.passport_id).first<{ token_hash: string; revoked_at: number | null }>();
  if (!row || row.token_hash !== (await sha256Hex(token))) return { ok: false, reason: "unknown", passport: v.passport };
  if (row.revoked_at) return { ok: false, reason: "revoked", passport: v.passport };
  if (opts.checkGenome !== false) {
    const facts = await genomeFacts(env, v.passport.agent_id);
    if (!facts || facts.genome_hash !== v.passport.genome_hash) return { ok: false, reason: "genome_changed", passport: v.passport };
  }
  return v;
}

export async function revokePassport(env: Env, passportId: string, reason: string, actor = "owner"): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE army_passports SET revoked_at = ?2, revoke_reason = ?3 WHERE id = ?1 AND revoked_at IS NULL").bind(passportId, Date.now(), reason.slice(0, 200)).run();
  const ok = (r.meta?.changes ?? 0) > 0;
  if (ok) await armyAudit(env.DB, actor, "army.passport.revoke", passportId, { reason });
  return ok;
}

export async function listPassports(env: Env, opts: { agent_id?: string; live?: boolean; limit?: number } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.agent_id) where.push(`agent_id = ?${args.push(opts.agent_id)}`);
  if (opts.live) where.push(`revoked_at IS NULL AND expires_at > ?${args.push(Date.now())}`);
  const lim = Math.min(Math.max(1, opts.limit ?? 100), 500);
  return (
    await env.DB.prepare(`SELECT id, agent_id, genome_id, genome_hash, lineage_id, rank, division, autonomy, redteam_score, issued_at, expires_at, revoked_at, revoke_reason FROM army_passports ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY issued_at DESC LIMIT ${lim}`)
      .bind(...args)
      .all()
  ).results;
}

export const autonomyAllows = (p: PassportBody, need: AutonomyLevel) => levelNum(p.autonomy) >= levelNum(need);
