/**
 * D1 access for the Studio tables of migration 0008 (studio_briefs, studio_designs; service_versions on promotion).
 * Every entry point calls ensureStudioServicesSchema first, so the Studio works on a DB where 0008 has not been
 * applied yet (the DDL is CREATE ... IF NOT EXISTS only).
 */
import type { Env } from "../env";
import { ensureStudioServicesSchema } from "../services/schema";
import { newId, safeJsonParse } from "../util";
import { fromStored, STUDIO_BRIEFS, toStored } from "./briefs";
import type { DesignRow, DesignStatus, StoredBrief, StudioBrief } from "./types";

export interface BriefRow {
  id: string;
  title: string;
  title_ar: string;
  spec: StoredBrief;
  source: "seed" | "owner";
  created_at: number;
  updated_at: number;
}

type RawBrief = Omit<BriefRow, "spec"> & { spec: string };
const toBrief = (r: RawBrief): BriefRow => ({ ...r, spec: safeJsonParse<StoredBrief>(r.spec)! });

const SEED_SPECS = STUDIO_BRIEFS.map((b) => ({ b, spec: JSON.stringify(toStored(b)) }));

/**
 * Lazily write the 12 seed briefs. Cheap when nothing changed (one SELECT of 12 lengths); a seed whose stored spec
 * differs from the code (by length) is refreshed. Owner briefs are never touched.
 */
export async function seedBriefs(env: Env): Promise<{ written: string[] }> {
  await ensureStudioServicesSchema(env);
  const rows = (await env.DB.prepare("SELECT id, length(spec) AS n, source FROM studio_briefs").all<{ id: string; n: number; source: string }>()).results;
  const have = new Map(rows.map((r) => [r.id, r]));
  const now = Date.now();
  const stale = SEED_SPECS.filter(({ b, spec }) => {
    const r = have.get(b.id);
    return !r || (r.source === "seed" && r.n !== spec.length);
  });
  if (!stale.length) return { written: [] };
  await env.DB.batch(
    stale.map(({ b, spec }) =>
      env.DB.prepare(
        `INSERT INTO studio_briefs (id, title, title_ar, spec, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'seed', ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_ar = excluded.title_ar, spec = excluded.spec, updated_at = excluded.updated_at
         WHERE studio_briefs.source = 'seed'`,
      ).bind(b.id, b.title, b.title_ar, spec, now),
    ),
  );
  return { written: stale.map((s) => s.b.id) };
}

export async function listBriefRows(env: Env): Promise<BriefRow[]> {
  await seedBriefs(env);
  return (await env.DB.prepare("SELECT * FROM studio_briefs ORDER BY source DESC, created_at, id").all<RawBrief>()).results.map(toBrief);
}

export async function getBriefRow(env: Env, id: string): Promise<BriefRow | null> {
  await seedBriefs(env);
  const r = await env.DB.prepare("SELECT * FROM studio_briefs WHERE id = ?1").bind(id).first<RawBrief>();
  return r ? toBrief(r) : null;
}

/** Runnable brief (seed behaviours re-attached), or null. */
export async function loadBrief(env: Env, id: string): Promise<StudioBrief | null> {
  const r = await getBriefRow(env, id);
  return r?.spec ? fromStored(r.spec) : null;
}

/** Insert or replace an owner brief. Refuses to overwrite a seed brief. */
export async function putOwnerBrief(env: Env, spec: StoredBrief): Promise<{ row: BriefRow; created: boolean }> {
  await seedBriefs(env);
  const ex = await env.DB.prepare("SELECT source FROM studio_briefs WHERE id = ?1").bind(spec.id).first<{ source: string }>();
  if (ex?.source === "seed") throw new StudioStoreError("conflict", `brief '${spec.id}' is a seed brief`);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO studio_briefs (id, title, title_ar, spec, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'owner', ?5, ?5)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_ar = excluded.title_ar, spec = excluded.spec, updated_at = excluded.updated_at`,
  )
    .bind(spec.id, spec.title, spec.title_ar, JSON.stringify(spec), now)
    .run();
  return { row: (await getBriefRow(env, spec.id))!, created: !ex };
}

export class StudioStoreError extends Error {
  constructor(
    public code: "conflict" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- designs

type RawDesign = Omit<DesignRow, "report"> & { report: string | null };
const toDesign = (r: RawDesign): DesignRow => ({ ...r, report: safeJsonParse(r.report) });

export async function createDesign(env: Env, d: { brief_id: string; lineage_id: string; job_id?: string | null }): Promise<DesignRow> {
  await ensureStudioServicesSchema(env);
  const v = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM studio_designs WHERE brief_id = ?1").bind(d.brief_id).first<{ v: number }>();
  const id = newId("sd");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO studio_designs (id, brief_id, lineage_id, version, status, job_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'designing', ?5, ?6, ?6)",
  )
    .bind(id, d.brief_id, d.lineage_id, (v?.v ?? 0) + 1, d.job_id ?? null, now)
    .run();
  return (await getDesign(env, id))!;
}

export async function getDesign(env: Env, id: string): Promise<DesignRow | null> {
  await ensureStudioServicesSchema(env);
  const r = await env.DB.prepare("SELECT * FROM studio_designs WHERE id = ?1").bind(id).first<RawDesign>();
  return r ? toDesign(r) : null;
}

export async function listDesigns(env: Env, f: { brief_id?: string; status?: string; limit?: number } = {}): Promise<DesignRow[]> {
  await ensureStudioServicesSchema(env);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.brief_id) (args.push(f.brief_id), where.push(`brief_id = ?${args.length}`));
  if (f.status) (args.push(f.status), where.push(`status = ?${args.length}`));
  args.push(Math.min(Math.max(1, Math.floor(f.limit ?? 50) || 50), 500));
  const sql = `SELECT * FROM studio_designs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ?${args.length}`;
  return (await env.DB.prepare(sql).bind(...args).all<RawDesign>()).results.map(toDesign);
}

export interface DesignPatch {
  status?: DesignStatus;
  genome_id?: string | null;
  suite_id?: string | null;
  report?: unknown;
  promoted_at?: number | null;
}

export async function updateDesign(env: Env, id: string, p: DesignPatch): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [id];
  const add = (col: string, v: unknown) => (args.push(v), sets.push(`${col} = ?${args.length}`));
  if (p.status !== undefined) add("status", p.status);
  if (p.genome_id !== undefined) add("genome_id", p.genome_id);
  if (p.suite_id !== undefined) add("suite_id", p.suite_id);
  if (p.report !== undefined) add("report", JSON.stringify(p.report));
  if (p.promoted_at !== undefined) add("promoted_at", p.promoted_at);
  add("updated_at", Date.now());
  await env.DB.prepare(`UPDATE studio_designs SET ${sets.join(", ")} WHERE id = ?1`).bind(...args).run();
}

/** Latest design per brief (for the briefs list). */
export async function latestDesigns(env: Env): Promise<Map<string, DesignRow>> {
  await ensureStudioServicesSchema(env);
  const rows = (
    await env.DB.prepare(
      "SELECT d.* FROM studio_designs d JOIN (SELECT brief_id, MAX(created_at) AS m FROM studio_designs GROUP BY brief_id) x ON x.brief_id = d.brief_id AND x.m = d.created_at",
    ).all<RawDesign>()
  ).results.map(toDesign);
  return new Map(rows.map((r) => [r.brief_id, r]));
}

/** Next service version for a slug and insert the row (no FK: the services layer owns `services`). */
export async function insertServiceVersion(env: Env, v: { slug: string; design_id: string; genome_id: string; eval_summary: unknown }): Promise<number> {
  await ensureStudioServicesSchema(env);
  const row = await env.DB.prepare(
    `INSERT INTO service_versions (slug, version, design_id, genome_id, eval_summary, created_at)
     VALUES (?1, (SELECT COALESCE(MAX(version), 0) + 1 FROM service_versions WHERE slug = ?1), ?2, ?3, ?4, ?5) RETURNING version`,
  )
    .bind(v.slug, v.design_id, v.genome_id, JSON.stringify(v.eval_summary), Date.now())
    .first<{ version: number }>();
  return row?.version ?? 0;
}
