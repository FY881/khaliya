/**
 * D1 data access for the Eval Factory: suites, items, results.
 *
 * Identity: an item's `norm_hash` = sha256(suite_id + normalized task + canonical inputs); its id is
 * `ei_<hash prefix>`. The same task+inputs can therefore exist once per suite, never twice.
 * Visibility: agents only ever see ACTIVE PUBLIC items, and never the reference or the checker's
 * expected value (only a format hint). The owner / Governor view returns everything.
 */
import type { Role } from "../constitution";
import type { Env } from "../env";
import { canonicalJson, safeJsonParse, sha256Hex } from "../util";
import { formatHint } from "./checkers";
import type { SuiteDef } from "./families";
import { normalizeText, shingles, jaccard } from "./text";
import type { Checker, EvalItem, ItemSpec, ItemStatus, Split, ValidationReport } from "./types";

export const NEAR_DUP_THRESHOLD = 0.85;

export interface EvalSuite {
  id: string;
  role: Role;
  name: string;
  name_ar: string | null;
  description: string | null;
  level: number;
  status: "active" | "paused";
  saturation: number | null;
  saturation_genome: string | null;
  saturated_at: number | null;
  ladder_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What an agent may see of an item. No reference, no checker internals. */
export interface PublicItemView {
  id: string;
  suite_id: string;
  task: string;
  inputs: Record<string, unknown>;
  difficulty: number;
  tags: string[];
  format: string;
}

export interface EvalResultRow {
  id: number;
  item_id: string;
  genome_id: string;
  context: string;
  ref: string | null;
  pass: boolean;
  score: number;
  answer: string | null;
  judge: unknown;
  tokens: number;
  at: number;
}

export type ResultContext = "validation" | "sandbox" | "tournament" | "canary" | "saturation" | "recheck";

// ---------------- hashing / similarity ----------------

/** Text used for identity: normalized task + canonical inputs. */
export function itemText(task: string, inputs: Record<string, unknown>): string {
  return `${normalizeText(task)}\n${canonicalJson(inputs ?? {})}`;
}

export async function itemHash(suiteId: string, task: string, inputs: Record<string, unknown>): Promise<string> {
  return sha256Hex(`${suiteId}\n${itemText(task, inputs)}`);
}

export const itemIdFromHash = (hash: string) => `ei_${hash.slice(0, 24)}`;

/**
 * Near-duplicate test. Two items from the same template differ only in their data, so a template match
 * alone is not a duplicate: an item is a near-duplicate iff its task AND its inputs are each ≥ threshold
 * similar (3-char shingle Jaccard), or the combined text is.
 */
export function nearDupScore(a: { task: string; inputs: Record<string, unknown> }, b: { task: string; inputs: Record<string, unknown> }): number {
  const t = jaccard(shingles(a.task), shingles(b.task));
  const i = jaccard(shingles(canonicalJson(a.inputs ?? {})), shingles(canonicalJson(b.inputs ?? {})));
  return Math.round(Math.min(t, i) * 1000) / 1000;
}

// ---------------- row mapping ----------------

interface ItemRow {
  id: string;
  suite_id: string;
  role: string;
  task: string;
  inputs: string;
  checker: string;
  reference: string | null;
  difficulty: number;
  tags: string;
  split: string;
  status: string;
  quality: number | null;
  norm_hash: string;
  validation: string | null;
  author: string;
  author_lineage: string | null;
  checks: number;
  flakes: number;
  status_reason: string | null;
  created_at: number;
  updated_at: number;
}

function toItem(r: ItemRow): EvalItem {
  return {
    id: r.id,
    suite_id: r.suite_id,
    role: r.role as Role,
    task: r.task,
    inputs: safeJsonParse<Record<string, unknown>>(r.inputs) ?? {},
    checker: safeJsonParse<Checker>(r.checker) as Checker,
    reference: r.reference ?? "",
    difficulty: r.difficulty,
    tags: safeJsonParse<string[]>(r.tags) ?? [],
    split: r.split as Split,
    status: r.status as ItemStatus,
    quality: r.quality,
    norm_hash: r.norm_hash,
    validation: safeJsonParse<ValidationReport>(r.validation),
    author: r.author,
    author_lineage: r.author_lineage,
    checks: r.checks,
    flakes: r.flakes,
    status_reason: r.status_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function publicView(i: EvalItem): PublicItemView {
  return { id: i.id, suite_id: i.suite_id, task: i.task, inputs: i.inputs, difficulty: i.difficulty, tags: i.tags, format: formatHint(i.checker) };
}

// ---------------- suites ----------------

/** Idempotent: inserts the suite if missing, refreshes its labels otherwise (level/saturation untouched). */
export async function ensureSuite(env: Env, def: SuiteDef, level = 5): Promise<EvalSuite> {
  const at = Date.now();
  await env.DB.prepare(
    `INSERT INTO eval_suites (id, role, name, name_ar, description, level, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)
     ON CONFLICT(id) DO UPDATE SET role = excluded.role, name = excluded.name, name_ar = excluded.name_ar, description = excluded.description`,
  )
    .bind(def.id, def.role, def.name, def.name_ar, def.description, level, at)
    .run();
  return (await getSuite(env, def.id))!;
}

export async function getSuite(env: Env, id: string): Promise<EvalSuite | null> {
  return env.DB.prepare("SELECT * FROM eval_suites WHERE id = ?1").bind(id).first<EvalSuite>();
}

export async function listSuites(env: Env): Promise<EvalSuite[]> {
  return (await env.DB.prepare("SELECT * FROM eval_suites ORDER BY id").all<EvalSuite>()).results;
}

export async function updateSuite(
  env: Env,
  id: string,
  patch: Partial<Pick<EvalSuite, "level" | "status" | "saturation" | "saturation_genome" | "saturated_at" | "ladder_requested_at">>,
): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const sets = keys.map((k, n) => `${k} = ?${n + 2}`).join(", ");
  await env.DB.prepare(`UPDATE eval_suites SET ${sets}, updated_at = ?${keys.length + 2} WHERE id = ?1`)
    .bind(id, ...keys.map((k) => patch[k] ?? null), Date.now())
    .run();
}

// ---------------- items ----------------

export interface InsertItemOptions {
  role: Role;
  author: string;
  author_lineage?: string | null;
  status?: ItemStatus;
  quality?: number | null;
  validation?: ValidationReport | null;
  status_reason?: string | null;
}

/** Insert an item. Returns null if an item with the same hash already exists (no overwrite). */
export async function insertItem(env: Env, spec: ItemSpec, o: InsertItemOptions): Promise<EvalItem | null> {
  const hash = await itemHash(spec.suite_id, spec.task, spec.inputs);
  const id = itemIdFromHash(hash);
  const at = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO eval_items (id, suite_id, role, task, inputs, checker, reference, difficulty, tags, split, status, quality, norm_hash, validation, author, author_lineage, status_reason, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      id,
      spec.suite_id,
      o.role,
      spec.task,
      JSON.stringify(spec.inputs ?? {}),
      JSON.stringify(spec.checker),
      spec.reference,
      spec.difficulty,
      JSON.stringify(spec.tags ?? []),
      spec.split,
      o.status ?? "pending",
      o.quality ?? null,
      hash,
      o.validation ? JSON.stringify(o.validation) : null,
      o.author,
      o.author_lineage ?? null,
      o.status_reason ?? null,
      at,
    )
    .run();
  if (!r.meta.changes) return null;
  return getItem(env, id);
}

export async function getItem(env: Env, id: string): Promise<EvalItem | null> {
  const r = await env.DB.prepare("SELECT * FROM eval_items WHERE id = ?1").bind(id).first<ItemRow>();
  return r ? toItem(r) : null;
}

export async function getItemByHash(env: Env, hash: string): Promise<EvalItem | null> {
  const r = await env.DB.prepare("SELECT * FROM eval_items WHERE norm_hash = ?1").bind(hash).first<ItemRow>();
  return r ? toItem(r) : null;
}

export interface ItemFilter {
  suite_id?: string;
  status?: ItemStatus | ItemStatus[];
  split?: Split | Split[];
  author?: string;
  limit?: number;
}

/** Owner / Governor view: everything, including references and checkers. */
export async function listItems(env: Env, f: ItemFilter = {}): Promise<EvalItem[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  const inList = (col: string, v: string | string[]) => {
    const xs = Array.isArray(v) ? v : [v];
    where.push(`${col} IN (${xs.map(() => "?").join(", ")})`);
    args.push(...xs);
  };
  if (f.suite_id) inList("suite_id", f.suite_id);
  if (f.status) inList("status", f.status);
  if (f.split) inList("split", f.split);
  if (f.author) inList("author", f.author);
  const sql = `SELECT * FROM eval_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id LIMIT ${Math.max(1, Math.min(5000, f.limit ?? 1000))}`;
  return (await env.DB.prepare(sql).bind(...args).all<ItemRow>()).results.map(toItem);
}

/** Agent view: active public items only, stripped of reference and checker. */
export async function listPublicItems(env: Env, suiteId?: string, limit = 200): Promise<PublicItemView[]> {
  return (await listItems(env, { suite_id: suiteId, status: "active", split: "public", limit })).map(publicView);
}

/** Closest existing non-rejected item in the suite with near-dup score ≥ threshold (or null). */
export async function findNearDuplicate(
  env: Env,
  suiteId: string,
  probe: { task: string; inputs: Record<string, unknown> },
  threshold = NEAR_DUP_THRESHOLD,
  excludeId?: string,
): Promise<{ id: string; similarity: number } | null> {
  const rows = (
    await env.DB.prepare("SELECT id, task, inputs FROM eval_items WHERE suite_id = ?1 AND status != 'rejected'")
      .bind(suiteId)
      .all<{ id: string; task: string; inputs: string }>()
  ).results;
  let best: { id: string; similarity: number } | null = null;
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const s = nearDupScore(probe, { task: r.task, inputs: safeJsonParse(r.inputs) ?? {} });
    if (s >= threshold && (!best || s > best.similarity)) best = { id: r.id, similarity: s };
  }
  return best;
}

/** Highest near-dup score against the suite (0 if empty). Used for the novelty part of quality. */
export async function maxSimilarity(env: Env, suiteId: string, probe: { task: string; inputs: Record<string, unknown> }): Promise<number> {
  const rows = (
    await env.DB.prepare("SELECT task, inputs FROM eval_items WHERE suite_id = ?1 AND status != 'rejected'").bind(suiteId).all<{ task: string; inputs: string }>()
  ).results;
  return rows.reduce((m, r) => Math.max(m, nearDupScore(probe, { task: r.task, inputs: safeJsonParse(r.inputs) ?? {} })), 0);
}

export async function setItemStatus(
  env: Env,
  id: string,
  status: ItemStatus,
  extra: { quality?: number | null; validation?: ValidationReport | null; reason?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE eval_items SET status = ?2,
       quality = CASE WHEN ?3 THEN ?4 ELSE quality END,
       validation = CASE WHEN ?5 THEN ?6 ELSE validation END,
       status_reason = CASE WHEN ?7 THEN ?8 ELSE status_reason END,
       updated_at = ?9 WHERE id = ?1`,
  )
    .bind(
      id,
      status,
      extra.quality !== undefined ? 1 : 0,
      extra.quality ?? null,
      extra.validation !== undefined ? 1 : 0,
      extra.validation ? JSON.stringify(extra.validation) : null,
      extra.reason !== undefined ? 1 : 0,
      extra.reason ?? null,
      Date.now(),
    )
    .run();
}

/** Count one re-check; `flaked` adds a flake. Returns the new counters. */
export async function bumpChecks(env: Env, id: string, flaked: boolean): Promise<{ checks: number; flakes: number }> {
  const r = await env.DB.prepare("UPDATE eval_items SET checks = checks + 1, flakes = flakes + ?2, updated_at = ?3 WHERE id = ?1 RETURNING checks, flakes")
    .bind(id, flaked ? 1 : 0, Date.now())
    .first<{ checks: number; flakes: number }>();
  return r ?? { checks: 0, flakes: 0 };
}

export interface ItemCounts {
  total: number;
  by_status: Record<string, number>;
  by_split_status: Record<string, number>; // "public:active" → n
}

export async function countItems(env: Env, suiteId: string): Promise<ItemCounts> {
  const rows = (
    await env.DB.prepare("SELECT split, status, COUNT(*) AS n FROM eval_items WHERE suite_id = ?1 GROUP BY split, status").bind(suiteId).all<{ split: string; status: string; n: number }>()
  ).results;
  const out: ItemCounts = { total: 0, by_status: {}, by_split_status: {} };
  for (const r of rows) {
    out.total += r.n;
    out.by_status[r.status] = (out.by_status[r.status] ?? 0) + r.n;
    out.by_split_status[`${r.split}:${r.status}`] = r.n;
  }
  return out;
}

// ---------------- results ----------------

export interface ResultInput {
  item_id: string;
  genome_id: string;
  context: ResultContext;
  ref?: string | null;
  pass: boolean;
  score: number;
  answer?: string | null;
  judge?: unknown;
  tokens?: number;
  at?: number;
}

export async function recordResult(env: Env, r: ResultInput): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO eval_results (item_id, genome_id, context, ref, pass, score, answer, judge, tokens, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id",
  )
    .bind(
      r.item_id,
      r.genome_id,
      r.context,
      r.ref ?? null,
      r.pass ? 1 : 0,
      r.score,
      r.answer == null ? null : String(r.answer).slice(0, 4000),
      r.judge === undefined ? null : JSON.stringify(r.judge).slice(0, 8000),
      r.tokens ?? 0,
      r.at ?? Date.now(),
    )
    .first<{ id: number }>();
  return row?.id ?? 0;
}

interface ResultRowRaw extends Omit<EvalResultRow, "pass" | "judge"> {
  pass: number;
  judge: string | null;
}

/** Results for an item (optionally one genome / context), oldest first. */
export async function resultsFor(env: Env, itemId: string, opts: { genome_id?: string; context?: ResultContext; limit?: number } = {}): Promise<EvalResultRow[]> {
  const where = ["item_id = ?1"];
  const args: unknown[] = [itemId];
  if (opts.genome_id) {
    args.push(opts.genome_id);
    where.push(`genome_id = ?${args.length}`);
  }
  if (opts.context) {
    args.push(opts.context);
    where.push(`context = ?${args.length}`);
  }
  const rows = (
    await env.DB.prepare(`SELECT * FROM eval_results WHERE ${where.join(" AND ")} ORDER BY at, id LIMIT ${Math.max(1, Math.min(1000, opts.limit ?? 500))}`)
      .bind(...args)
      .all<ResultRowRaw>()
  ).results;
  return rows.map((r) => ({ ...r, pass: r.pass === 1, judge: safeJsonParse(r.judge) }));
}
