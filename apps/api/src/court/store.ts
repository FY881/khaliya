/**
 * Judge Court storage: probe rows, the owner spot-check queue, and Cohen's kappa against owner labels.
 *
 * Spot-checks are opened when (a) a judge disagrees with a gold anchor, (b) a judge's verdict changes between EN and
 * AR for the same item, (c) two judges reach different order-stable verdicts on the same pair, plus (d) a small
 * deterministic sample of agreeing gold units so kappa has data even when nothing is wrong (~20 items/week budget).
 * Items are shown with A = the answer under test (X) and B = its counterpart (Y); judge verdicts use the same letters.
 */
import { newId, safeJsonParse } from "../util";
import type { Env } from "../env";
import type { ProbeRow, Side } from "./probe";

export type Label = "A" | "B" | "tie";
export const toLabel = (v: Side | "draw"): Label => (v === "X" ? "A" : v === "Y" ? "B" : "tie");
export const SPOT_WEEKLY_CAP = 20;

export async function insertProbeRows(env: Env, rows: ProbeRow[], jobId: string | null): Promise<void> {
  if (!rows.length) return;
  const now = Date.now();
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        "INSERT INTO court_probes (judge_model, judge_family, probe, lang, item_key, ab, ba, verdict, consistent, outcome, detail, job_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
      ).bind(r.judge_model, r.judge_family, r.probe, r.lang, r.item_key, r.ab, r.ba, r.verdict, r.consistent ? 1 : 0, r.outcome, r.detail ? JSON.stringify(r.detail) : null, jobId, now),
    ),
  );
}

export interface SpotCheck {
  id: string;
  judge_model: string | null;
  lang: "en" | "ar";
  item_key: string;
  item: { task: string; criteria: unknown; answer_a: string; answer_b: string; probe: string };
  judge_verdicts: Record<string, Label>;
  reason: string;
  owner_label: Label | null;
  status: "open" | "labelled" | "skipped";
  created_at: number;
  labelled_at: number | null;
}

type Raw = Omit<SpotCheck, "item" | "judge_verdicts"> & { item: string; judge_verdicts: string };
const toSpot = (r: Raw): SpotCheck => ({ ...r, item: safeJsonParse(r.item) as SpotCheck["item"], judge_verdicts: safeJsonParse<Record<string, Label>>(r.judge_verdicts) ?? {} });

async function openedThisWeek(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM court_spotchecks WHERE created_at >= ?1").bind(Date.now() - 7 * 86_400_000).first<{ n: number }>())?.n ?? 0;
}

/**
 * Open (or merge verdicts into) a spot-check for this pair. Disagreements always open one; `sample` ones only while
 * the weekly cap allows. Returns the spot-check id, or null when capped.
 */
export async function upsertSpotCheck(env: Env, row: ProbeRow, reason: string, opts: { sample?: boolean } = {}): Promise<string | null> {
  if (!row.answers) return null;
  const key = row.item_key;
  const ex = await env.DB.prepare("SELECT * FROM court_spotchecks WHERE item_key = ?1 AND lang = ?2").bind(key, row.lang).first<Raw>();
  if (ex) {
    const v = { ...(safeJsonParse<Record<string, Label>>(ex.judge_verdicts) ?? {}), [row.judge_model]: toLabel(row.verdict) };
    const why = ex.reason.includes(reason) ? ex.reason : `${ex.reason}; ${reason}`.slice(0, 400);
    await env.DB.prepare("UPDATE court_spotchecks SET judge_verdicts = ?2, reason = ?3 WHERE id = ?1").bind(ex.id, JSON.stringify(v), why).run();
    return ex.id;
  }
  if (opts.sample && (await openedThisWeek(env)) >= SPOT_WEEKLY_CAP) return null;
  const id = newId("spot");
  const item = { task: row.answers.task, criteria: row.answers.criteria, answer_a: row.answers.x, answer_b: row.answers.y, probe: row.probe };
  await env.DB.prepare("INSERT INTO court_spotchecks (id, judge_model, lang, item_key, item, judge_verdicts, reason, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8) ON CONFLICT(item_key, lang) DO NOTHING")
    .bind(id, row.judge_model, row.lang, key, JSON.stringify(item), JSON.stringify({ [row.judge_model]: toLabel(row.verdict) }), reason, Date.now())
    .run();
  return id;
}

/** Owner creates a spot-check by hand (e.g. from a real tournament disagreement). */
export async function createSpotCheck(
  env: Env,
  s: { lang: "en" | "ar"; item_key?: string; task: string; answer_a: string; answer_b: string; criteria?: unknown; judge_verdicts?: Record<string, Label>; reason?: string },
): Promise<SpotCheck> {
  const id = newId("spot");
  const key = s.item_key ?? `manual:${id}`;
  await env.DB.prepare("INSERT INTO court_spotchecks (id, judge_model, lang, item_key, item, judge_verdicts, reason, status, created_at) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, 'open', ?7)")
    .bind(id, s.lang, key, JSON.stringify({ task: s.task, criteria: s.criteria ?? [], answer_a: s.answer_a, answer_b: s.answer_b, probe: "manual" }), JSON.stringify(s.judge_verdicts ?? {}), s.reason ?? "owner", Date.now())
    .run();
  return (await getSpotCheck(env, id))!;
}

export async function getSpotCheck(env: Env, id: string): Promise<SpotCheck | null> {
  const r = await env.DB.prepare("SELECT * FROM court_spotchecks WHERE id = ?1").bind(id).first<Raw>();
  return r ? toSpot(r) : null;
}

export async function listSpotChecks(env: Env, f: { status?: string; lang?: string; limit?: number } = {}): Promise<SpotCheck[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) where.push(`status = ?${args.push(f.status)}`);
  if (f.lang) where.push(`lang = ?${args.push(f.lang)}`);
  const lim = Math.min(Math.max(1, Math.floor(f.limit ?? 30)), 200);
  const rows = (await env.DB.prepare(`SELECT * FROM court_spotchecks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ${lim}`).bind(...args).all<Raw>()).results;
  return rows.map(toSpot);
}

export async function labelSpotCheck(env: Env, id: string, label: Label | "skip"): Promise<SpotCheck | null> {
  const s = await getSpotCheck(env, id);
  if (!s) return null;
  if (label === "skip") await env.DB.prepare("UPDATE court_spotchecks SET status = 'skipped', owner_label = NULL, labelled_at = ?2 WHERE id = ?1").bind(id, Date.now()).run();
  else await env.DB.prepare("UPDATE court_spotchecks SET status = 'labelled', owner_label = ?2, labelled_at = ?3 WHERE id = ?1").bind(id, label, Date.now()).run();
  return getSpotCheck(env, id);
}

// ------------------------------------------------------------------ kappa
/** Cohen's kappa over paired categorical labels. null when there is no data. */
export function cohenKappa(pairs: [string, string][]): number | null {
  const n = pairs.length;
  if (!n) return null;
  const cats = [...new Set(pairs.flat())];
  const po = pairs.filter(([a, b]) => a === b).length / n;
  let pe = 0;
  for (const c of cats) pe += (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n);
  if (pe >= 1) return po === 1 ? 1 : 0;
  return Math.round(((po - pe) / (1 - pe)) * 1000) / 1000;
}

export interface KappaReport {
  judge: string;
  en: { kappa: number | null; n: number };
  ar: { kappa: number | null; n: number };
}

/** Kappa of every judge vs owner labels, EN and AR separately. */
export async function kappaByJudge(env: Env): Promise<Record<string, KappaReport>> {
  const rows = (await env.DB.prepare("SELECT lang, judge_verdicts, owner_label FROM court_spotchecks WHERE status = 'labelled' AND owner_label IS NOT NULL").all<{ lang: "en" | "ar"; judge_verdicts: string; owner_label: Label }>()).results;
  const pairs = new Map<string, { en: [string, string][]; ar: [string, string][] }>();
  for (const r of rows) {
    const v = safeJsonParse<Record<string, Label>>(r.judge_verdicts) ?? {};
    for (const [judge, verdict] of Object.entries(v)) {
      const p = pairs.get(judge) ?? { en: [], ar: [] };
      p[r.lang].push([verdict, r.owner_label]);
      pairs.set(judge, p);
    }
  }
  const out: Record<string, KappaReport> = {};
  for (const [judge, p] of pairs) out[judge] = { judge, en: { kappa: cohenKappa(p.en), n: p.en.length }, ar: { kappa: cohenKappa(p.ar), n: p.ar.length } };
  return out;
}
