/**
 * D1 data access for the Tool Forge (migration 0004_forge.sql).
 *
 * Identity: a tool row's id is `ft_<first 24 hex of its content hash>`; (name, hash) is unique, so the same
 * submission is stored once. Versions count up per name. Only `admitted` rows are ever executable; when a
 * newer version of a name is admitted, older admitted versions become `deprecated` (superseded).
 */
import type { Env } from "../env";
import { safeJsonParse } from "../util";
import type { AdmissionReport, ForgeStatus, ForgeToolSpec } from "./types";

export interface ForgeToolRow {
  id: string;
  name: string;
  version: number;
  hash: string;
  status: ForgeStatus;
  status_reason: string | null;
  author: string;
  lineage_id: string | null;
  /** Spec without the code (code is its own column). */
  spec: Omit<ForgeToolSpec, "code">;
  code: string;
  report: AdmissionReport | null;
  uses: number;
  successes: number;
  failures: number;
  last_used_at: number | null;
  admitted_at: number | null;
  created_at: number;
  updated_at: number;
}

export const forgeIdFromHash = (hash: string) => `ft_${hash.slice(0, 24)}`;

type Raw = Omit<ForgeToolRow, "spec" | "report"> & { spec: string; report: string | null };

function fromRaw(r: Raw | null): ForgeToolRow | null {
  if (!r) return null;
  return { ...r, spec: (safeJsonParse(r.spec) ?? {}) as ForgeToolRow["spec"], report: safeJsonParse<AdmissionReport>(r.report) };
}

/** Full spec (with code) back from a stored row. */
export function specOf(row: ForgeToolRow): ForgeToolSpec {
  return { ...(row.spec as ForgeToolSpec), code: row.code };
}

export async function getTool(env: Env, id: string): Promise<ForgeToolRow | null> {
  return fromRaw(await env.DB.prepare("SELECT * FROM forge_tools WHERE id = ?1").bind(id).first<Raw>());
}

export async function getToolByHash(env: Env, name: string, hash: string): Promise<ForgeToolRow | null> {
  return fromRaw(await env.DB.prepare("SELECT * FROM forge_tools WHERE name = ?1 AND hash = ?2").bind(name, hash).first<Raw>());
}

/** The newest ADMITTED version of a name (or a specific admitted version). */
export async function getAdmittedTool(env: Env, name: string, version?: number): Promise<ForgeToolRow | null> {
  const q =
    version === undefined
      ? env.DB.prepare("SELECT * FROM forge_tools WHERE name = ?1 AND status = 'admitted' ORDER BY version DESC LIMIT 1").bind(name)
      : env.DB.prepare("SELECT * FROM forge_tools WHERE name = ?1 AND version = ?2 AND status = 'admitted'").bind(name, version);
  return fromRaw(await q.first<Raw>());
}

export interface ToolFilter {
  status?: ForgeStatus;
  name?: string;
  author?: string;
  limit?: number;
}

export async function listTools(env: Env, f: ToolFilter = {}): Promise<ForgeToolRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) where.push(`status = ?${args.push(f.status)}`);
  if (f.name) where.push(`name = ?${args.push(f.name)}`);
  if (f.author) where.push(`author = ?${args.push(f.author)}`);
  const limit = Math.max(1, Math.min(f.limit ?? 100, 500));
  const sql = `SELECT * FROM forge_tools ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY name, version DESC LIMIT ${limit}`;
  const res = await env.DB.prepare(sql).bind(...args).all<Raw>();
  return (res.results ?? []).map((r) => fromRaw(r)!);
}

/** Admitted tools only, newest version per name. */
export async function listAdmittedTools(env: Env): Promise<ForgeToolRow[]> {
  const res = await env.DB.prepare(
    "SELECT t.* FROM forge_tools t WHERE t.status = 'admitted' AND t.version = (SELECT MAX(version) FROM forge_tools u WHERE u.name = t.name AND u.status = 'admitted') ORDER BY t.name",
  ).all<Raw>();
  return (res.results ?? []).map((r) => fromRaw(r)!);
}

export async function insertPendingTool(env: Env, spec: ForgeToolSpec, hash: string): Promise<ForgeToolRow> {
  const id = forgeIdFromHash(hash);
  const { code, ...rest } = spec;
  const name = String(spec.name ?? "");
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = Date.now();
    const v = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM forge_tools WHERE name = ?1").bind(name).first<{ v: number }>();
    try {
      await env.DB.prepare(
        `INSERT INTO forge_tools (id, name, version, hash, status, author, lineage_id, spec, code, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?9)`,
      )
        .bind(id, name, v?.v ?? 1, hash, String(spec.author ?? "unknown"), spec.lineage ? String(spec.lineage) : null, JSON.stringify(rest), String(code ?? ""), at)
        .run();
      return (await getTool(env, id))!;
    } catch (e) {
      const existing = await getTool(env, id);
      if (existing) return existing;
      if (attempt === 2) throw e; // version race: retry with the next number
    }
  }
  throw new Error("unreachable");
}

export async function setToolStatus(env: Env, id: string, status: ForgeStatus, report?: AdmissionReport | null, reason?: string): Promise<ForgeToolRow> {
  const at = Date.now();
  const row = await getTool(env, id);
  if (!row) throw new Error(`unknown forge tool '${id}'`);
  const statusReason = reason ?? report?.reason ?? null;
  const stmts = [
    env.DB.prepare(
      `UPDATE forge_tools SET status = ?2, status_reason = ?3, report = COALESCE(?4, report), updated_at = ?5,
         admitted_at = CASE WHEN ?2 = 'admitted' THEN ?5 ELSE admitted_at END WHERE id = ?1`,
    ).bind(id, status, statusReason, report ? JSON.stringify(report) : null, at),
  ];
  if (status === "admitted")
    stmts.push(
      env.DB.prepare(
        "UPDATE forge_tools SET status = 'deprecated', status_reason = ?3, updated_at = ?4 WHERE name = ?1 AND status = 'admitted' AND version < ?2",
      ).bind(row.name, row.version, `superseded by v${row.version}`, at),
    );
  await env.DB.batch(stmts);
  return (await getTool(env, id))!;
}

export interface ForgeRunInput {
  tool_id: string | null;
  context: "admission" | "call" | "verifier";
  caller?: string | null;
  run_id?: string | null;
  ok: boolean;
  error_kind?: string | null;
  ms?: number;
  fuel_used?: number;
  output_bytes?: number;
}

/** Log a sandbox execution; gateway calls also bump the tool's usage counters. */
export async function recordForgeRun(env: Env, r: ForgeRunInput): Promise<void> {
  const at = Date.now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO forge_runs (tool_id, context, caller, run_id, ok, error_kind, ms, fuel_used, output_bytes, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(r.tool_id, r.context, r.caller ?? null, r.run_id ?? null, r.ok ? 1 : 0, r.error_kind ?? null, r.ms ?? 0, r.fuel_used ?? 0, r.output_bytes ?? 0, at),
  ];
  if (r.context === "call" && r.tool_id)
    stmts.push(
      env.DB.prepare(
        "UPDATE forge_tools SET uses = uses + 1, successes = successes + ?2, failures = failures + ?3, last_used_at = ?4 WHERE id = ?1",
      ).bind(r.tool_id, r.ok ? 1 : 0, r.ok ? 0 : 1, at),
    );
  await env.DB.batch(stmts);
}

export async function runsFor(env: Env, toolId: string, limit = 20) {
  const res = await env.DB.prepare("SELECT * FROM forge_runs WHERE tool_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2").bind(toolId, Math.min(limit, 200)).all();
  return res.results ?? [];
}

/** success rate in [0,1], or null when never used. */
export const successRate = (t: Pick<ForgeToolRow, "uses" | "successes">) => (t.uses ? t.successes / t.uses : null);

/** Newest row of a name in any status (optionally a specific version). */
export async function getToolByName(env: Env, name: string, version?: number): Promise<ForgeToolRow | null> {
  const q =
    version === undefined
      ? env.DB.prepare("SELECT * FROM forge_tools WHERE name = ?1 ORDER BY version DESC LIMIT 1").bind(name)
      : env.DB.prepare("SELECT * FROM forge_tools WHERE name = ?1 AND version = ?2").bind(name, version);
  return fromRaw(await q.first<Raw>());
}

/** One row per name: the newest version, plus how many versions exist and which version (if any) is admitted. */
export async function listLatestTools(env: Env, status?: ForgeStatus): Promise<(ForgeToolRow & { versions: number; admitted_version: number | null })[]> {
  const res = await env.DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM forge_tools u WHERE u.name = t.name) AS versions,
            (SELECT MAX(version) FROM forge_tools a WHERE a.name = t.name AND a.status = 'admitted') AS admitted_version
     FROM forge_tools t WHERE t.version = (SELECT MAX(version) FROM forge_tools v WHERE v.name = t.name)
     ${status ? "AND t.status = ?1" : ""} ORDER BY t.name LIMIT 500`,
  )
    .bind(...(status ? [status] : []))
    .all<Raw & { versions: number; admitted_version: number | null }>();
  return (res.results ?? []).map((r) => ({ ...fromRaw(r)!, versions: r.versions, admitted_version: r.admitted_version }));
}

export async function toolVersions(env: Env, name: string) {
  return (
    (await env.DB.prepare("SELECT id, version, status, status_reason, author, hash, uses, created_at, admitted_at FROM forge_tools WHERE name = ?1 ORDER BY version DESC").bind(name).all()).results ?? []
  );
}

export async function forgeCounts(env: Env): Promise<Record<ForgeStatus, number>> {
  const rows = (await env.DB.prepare("SELECT status, COUNT(*) AS n FROM forge_tools GROUP BY status").all<{ status: ForgeStatus; n: number }>()).results ?? [];
  const out: Record<ForgeStatus, number> = { pending: 0, admitted: 0, rejected: 0, deprecated: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** Note on a pending row (e.g. "awaiting owner approval"). Only touches rows that are still pending. */
export async function setPendingReason(env: Env, id: string, reason: string | null): Promise<void> {
  await env.DB.prepare("UPDATE forge_tools SET status_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'pending'").bind(id, reason, Date.now()).run();
}

/** Owner retirement: every admitted version of `name` becomes deprecated (no longer executable). Returns how many. */
export async function retireToolName(env: Env, name: string, reason: string): Promise<number> {
  const r = await env.DB.prepare("UPDATE forge_tools SET status = 'deprecated', status_reason = ?2, updated_at = ?3 WHERE name = ?1 AND status IN ('admitted','pending')")
    .bind(name, reason.slice(0, 300), Date.now())
    .run();
  return r.meta?.changes ?? 0;
}
