/**
 * Per-judge reliability records (court_scores, one row per judge per day, kept over time) and the read side used by
 * judging: `courtWeights()` (weights for eval/judge.ts or tournaments to down-weight unreliable judges) and
 * `courtGate()` (§19 C5: a rubric-scored promotion needs ≥ 2 judges of different families with a current record
 * above threshold).
 *
 * Metrics over the last WINDOW_DAYS of probes (each needs ≥ MIN_N samples to count):
 *   position_consistency  share of position probes whose verdict survived the swap          target ≥ 0.9
 *   verbosity_bias        max(0, 2·(mean outcome − 0.5)) on padded-vs-concise               target ≤ 0.1
 *   self_pref_rate        mean outcome on own-family-vs-foreign (equal quality)            target 0.5 ± 0.05
 *   lang_consistency      share of items whose EN and AR verdicts match                      target ≥ 0.9
 *   gold_accuracy_en/ar   mean outcome on gold anchors (1 = right winner)
 *   kappa_en/ar           Cohen's κ vs owner spot-check labels                               target ≥ 0.6
 * reliability = weighted mean of the available components; weight = 0 when benched, else clamp(reliability, 0.1, 1).
 * Benched (hard floors): position < 0.6, gold < 0.6, |self_pref − 0.5| > 0.25, lang < 0.5, verbosity > 0.6,
 * or κ < 0.2 with ≥ 8 labels.
 */
import type { Env } from "../env";
import { today } from "../util";
import { judgeFamily } from "./probe";
import { kappaByJudge, type KappaReport } from "./store";

export const WINDOW_DAYS = 14;
export const MIN_N = 3;
export const STALE_DAYS = 7;
export const TARGETS = Object.freeze({ position: 0.9, self_pref_band: 0.05, kappa: 0.6, lang: 0.9, verbosity: 0.1 });
const W = { position: 0.3, gold: 0.25, lang: 0.15, self_pref: 0.1, verbosity: 0.1, kappa: 0.1 };

export interface JudgeRecord {
  judge_model: string;
  judge_family: string;
  day: string;
  n_probes: number;
  position_consistency: number | null;
  verbosity_bias: number | null;
  self_pref_rate: number | null;
  lang_consistency: number | null;
  gold_accuracy_en: number | null;
  gold_accuracy_ar: number | null;
  kappa_en: number | null;
  kappa_ar: number | null;
  n_labels: number;
  reliability: number;
  weight: number;
  benched: boolean;
  /** meets every §19 C5 success target that has data (and has position + self-pref data) */
  certified: boolean;
  reasons: string[];
  updated_at: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface Row {
  probe: string;
  lang: "en" | "ar";
  item_key: string;
  verdict: string;
  consistent: number;
  outcome: number | null;
  job_id: string | null;
  at: number;
}

/** Pure scoring of one judge's probe rows + kappa. Exported for tests. */
export function scoreJudge(judge: string, rows: Row[], kappa: KappaReport | undefined, day = today()): JudgeRecord {
  const of = (p: string) => rows.filter((r) => r.probe === p);
  const pos = of("position");
  const verb = of("verbosity").filter((r) => r.outcome !== null);
  const self = of("self_pref").filter((r) => r.outcome !== null);
  const gold = rows.filter((r) => (r.probe === "gold" || r.probe === "lang") && r.outcome !== null);
  // lang: pair EN/AR rows of the same item in the same job
  const byPair = new Map<string, Partial<Record<"en" | "ar", string>>>();
  for (const r of of("lang")) {
    const k = `${r.item_key}|${r.job_id ?? r.at}`;
    const e = byPair.get(k) ?? {};
    e[r.lang] = r.verdict;
    byPair.set(k, e);
  }
  const langPairs = [...byPair.values()].filter((p) => p.en && p.ar);

  const enough = <T>(xs: T[]) => xs.length >= MIN_N;
  const position_consistency = enough(pos) ? r3(mean(pos.map((r) => r.consistent))!) : null;
  const vm = mean(verb.map((r) => r.outcome!));
  const verbosity_bias = enough(verb) && vm !== null ? r3(Math.max(0, 2 * (vm - 0.5))) : null;
  const self_pref_rate = enough(self) ? r3(mean(self.map((r) => r.outcome!))!) : null;
  const lang_consistency = enough(langPairs) ? r3(langPairs.filter((p) => p.en === p.ar).length / langPairs.length) : null;
  const gEn = gold.filter((r) => r.lang === "en");
  const gAr = gold.filter((r) => r.lang === "ar");
  const gold_accuracy_en = enough(gEn) ? r3(mean(gEn.map((r) => r.outcome!))!) : null;
  const gold_accuracy_ar = enough(gAr) ? r3(mean(gAr.map((r) => r.outcome!))!) : null;
  const kappa_en = kappa && kappa.en.n >= MIN_N ? kappa.en.kappa : null;
  const kappa_ar = kappa && kappa.ar.n >= MIN_N ? kappa.ar.kappa : null;
  const n_labels = (kappa?.en.n ?? 0) + (kappa?.ar.n ?? 0);

  const golds = [gold_accuracy_en, gold_accuracy_ar].filter((x): x is number => x !== null);
  const goldAvg = golds.length ? mean(golds)! : null;
  const kappas = [kappa_en, kappa_ar].filter((x): x is number => x !== null);
  const kappaMin = kappas.length ? Math.min(...kappas) : null;
  const comps: [number, number | null][] = [
    [W.position, position_consistency],
    [W.gold, goldAvg],
    [W.lang, lang_consistency],
    [W.self_pref, self_pref_rate === null ? null : Math.max(0, 1 - Math.abs(self_pref_rate - 0.5) * 4)],
    [W.verbosity, verbosity_bias === null ? null : 1 - verbosity_bias],
    [W.kappa, kappaMin === null ? null : Math.max(0, kappaMin)],
  ];
  const avail = comps.filter(([, v]) => v !== null) as [number, number][];
  const tw = avail.reduce((s, [w]) => s + w, 0);
  const reliability = tw ? r3(avail.reduce((s, [w, v]) => s + w * v, 0) / tw) : 0.5;

  const reasons: string[] = [];
  let benched = false;
  const bench = (cond: boolean, why: string) => {
    if (cond) {
      benched = true;
      reasons.push(`benched: ${why}`);
    }
  };
  bench(position_consistency !== null && position_consistency < 0.6, `position consistency ${position_consistency} < 0.6`);
  bench(goldAvg !== null && goldAvg < 0.6, `gold accuracy ${r3(goldAvg ?? 0)} < 0.6`);
  bench(self_pref_rate !== null && Math.abs(self_pref_rate - 0.5) > 0.25, `self-preference ${self_pref_rate} outside 0.5 ± 0.25`);
  bench(lang_consistency !== null && lang_consistency < 0.5, `EN/AR consistency ${lang_consistency} < 0.5`);
  bench(verbosity_bias !== null && verbosity_bias > 0.6, `verbosity bias ${verbosity_bias} > 0.6`);
  bench(kappaMin !== null && n_labels >= 8 && kappaMin < 0.2, `kappa ${kappaMin} < 0.2`);

  const miss = (cond: boolean, why: string) => cond && reasons.push(`below target: ${why}`);
  miss(position_consistency !== null && position_consistency < TARGETS.position, `position consistency ${position_consistency} < ${TARGETS.position}`);
  miss(self_pref_rate !== null && Math.abs(self_pref_rate - 0.5) > TARGETS.self_pref_band, `self-preference ${self_pref_rate} outside 0.5 ± ${TARGETS.self_pref_band}`);
  miss(lang_consistency !== null && lang_consistency < TARGETS.lang, `EN/AR consistency ${lang_consistency} < ${TARGETS.lang}`);
  miss(verbosity_bias !== null && verbosity_bias > TARGETS.verbosity, `verbosity bias ${verbosity_bias} > ${TARGETS.verbosity}`);
  for (const [l, k] of [["EN", kappa_en], ["AR", kappa_ar]] as const) miss(k !== null && k < TARGETS.kappa, `kappa ${l} ${k} < ${TARGETS.kappa}`);
  if (position_consistency === null) reasons.push("no data: position");
  if (self_pref_rate === null) reasons.push("no data: self_pref");

  const certified = !benched && position_consistency !== null && self_pref_rate !== null && !reasons.some((r) => r.startsWith("below target"));
  return {
    judge_model: judge,
    judge_family: judgeFamily(judge),
    day,
    n_probes: rows.length,
    position_consistency,
    verbosity_bias,
    self_pref_rate,
    lang_consistency,
    gold_accuracy_en,
    gold_accuracy_ar,
    kappa_en,
    kappa_ar,
    n_labels,
    reliability,
    weight: benched ? 0 : r3(Math.min(1, Math.max(0.1, reliability))),
    benched,
    certified,
    reasons,
    updated_at: Date.now(),
  };
}

/** Recompute + store today's record for each judge (all judges with recent probes when `judges` is omitted). */
export async function refreshScores(env: Env, judges?: string[]): Promise<JudgeRecord[]> {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const list = judges?.length ? [...new Set(judges)] : (await env.DB.prepare("SELECT DISTINCT judge_model FROM court_probes WHERE at >= ?1").bind(since).all<{ judge_model: string }>()).results.map((r) => r.judge_model);
  const kappas = await kappaByJudge(env);
  const out: JudgeRecord[] = [];
  for (const j of list) {
    const rows = (await env.DB.prepare("SELECT probe, lang, item_key, verdict, consistent, outcome, job_id, at FROM court_probes WHERE judge_model = ?1 AND at >= ?2 ORDER BY at DESC LIMIT 600").bind(j, since).all<Row>()).results;
    if (!rows.length) continue;
    const rec = scoreJudge(j, rows, kappas[j]);
    await env.DB.prepare(
      `INSERT INTO court_scores (judge_model, day, judge_family, n_probes, position_consistency, verbosity_bias, self_pref_rate, lang_consistency, gold_accuracy_en, gold_accuracy_ar,
         kappa_en, kappa_ar, n_labels, reliability, weight, benched, reasons, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
       ON CONFLICT(judge_model, day) DO UPDATE SET judge_family = excluded.judge_family, n_probes = excluded.n_probes, position_consistency = excluded.position_consistency,
         verbosity_bias = excluded.verbosity_bias, self_pref_rate = excluded.self_pref_rate, lang_consistency = excluded.lang_consistency, gold_accuracy_en = excluded.gold_accuracy_en,
         gold_accuracy_ar = excluded.gold_accuracy_ar, kappa_en = excluded.kappa_en, kappa_ar = excluded.kappa_ar, n_labels = excluded.n_labels, reliability = excluded.reliability,
         weight = excluded.weight, benched = excluded.benched, reasons = excluded.reasons, updated_at = excluded.updated_at`,
    )
      .bind(rec.judge_model, rec.day, rec.judge_family, rec.n_probes, rec.position_consistency, rec.verbosity_bias, rec.self_pref_rate, rec.lang_consistency, rec.gold_accuracy_en, rec.gold_accuracy_ar, rec.kappa_en, rec.kappa_ar, rec.n_labels, rec.reliability, rec.weight, rec.benched ? 1 : 0, JSON.stringify(rec.reasons), rec.updated_at)
      .run();
    out.push(rec);
  }
  return out;
}

type ScoreRaw = Omit<JudgeRecord, "benched" | "certified" | "reasons"> & { benched: number; reasons: string };
const fromRaw = (r: ScoreRaw): JudgeRecord => {
  const reasons = JSON.parse(r.reasons || "[]") as string[];
  const benched = !!r.benched;
  return { ...r, benched, reasons, certified: !benched && r.position_consistency !== null && r.self_pref_rate !== null && !reasons.some((x) => x.startsWith("below target")) };
};

/** Latest record per judge. */
export async function latestRecords(env: Env): Promise<JudgeRecord[]> {
  const rows = (
    await env.DB.prepare("SELECT s.* FROM court_scores s JOIN (SELECT judge_model, MAX(day) AS day FROM court_scores GROUP BY judge_model) m ON m.judge_model = s.judge_model AND m.day = s.day ORDER BY s.judge_model").all<ScoreRaw>()
  ).results;
  return rows.map(fromRaw);
}

export async function judgeHistory(env: Env, judge: string, days = 30): Promise<JudgeRecord[]> {
  return (await env.DB.prepare(`SELECT * FROM court_scores WHERE judge_model = ?1 ORDER BY day DESC LIMIT ${Math.max(1, Math.min(120, days))}`).bind(judge).all<ScoreRaw>()).results.map(fromRaw);
}

export interface CourtWeight {
  weight: number;
  reliability: number | null;
  benched: boolean;
  certified: boolean;
  /** false = the judge has no record yet (neutral weight 1) */
  known: boolean;
  /** record older than STALE_DAYS */
  stale: boolean;
  day: string | null;
}

/**
 * Judge weights for eval/judge.ts (or tournaments). Unknown judges get a neutral weight of 1 (`known: false`) so the
 * court never silently zeroes a panel it has not measured; benched judges get 0. Never throws (a missing table or
 * D1 error yields neutral weights), so callers can use it unconditionally.
 */
export async function courtWeights(env: Env, models?: string[]): Promise<Record<string, CourtWeight>> {
  let recs: JudgeRecord[] = [];
  try {
    recs = await latestRecords(env);
  } catch {
    recs = [];
  }
  const out: Record<string, CourtWeight> = {};
  const staleBefore = today(Date.now() - STALE_DAYS * 86_400_000);
  for (const r of recs) out[r.judge_model] = { weight: r.weight, reliability: r.reliability, benched: r.benched, certified: r.certified, known: true, stale: r.day < staleBefore, day: r.day };
  for (const m of models ?? []) if (!out[m]) out[m] = { weight: 1, reliability: null, benched: false, certified: false, known: false, stale: false, day: null };
  if (models) for (const k of Object.keys(out)) if (!models.includes(k)) delete out[k];
  return out;
}

/** Weight of one model from a courtWeights() map (1 when absent). */
export const weightOf = (w: Record<string, CourtWeight>, model: string) => w[model]?.weight ?? 1;

/** Court-weighted mean of per-judge scores (falls back to the plain mean when every weight is 0). */
export function weightedJudgeScore(scores: { model: string; score: number }[], w: Record<string, CourtWeight>): number {
  if (!scores.length) return 0;
  const tw = scores.reduce((s, x) => s + weightOf(w, x.model), 0);
  if (tw <= 0) return r3(scores.reduce((s, x) => s + x.score, 0) / scores.length);
  return r3(scores.reduce((s, x) => s + x.score * weightOf(w, x.model), 0) / tw);
}

/**
 * §19 C5 gate for rubric-scored promotions: ≥ 2 judges from different families, none benched, each with a current
 * (non-stale) record; `strict` additionally requires each to be certified (all success targets met).
 */
export async function courtGate(env: Env, models: string[], opts: { strict?: boolean } = {}): Promise<{ ok: boolean; reasons: string[]; eligible: string[] }> {
  const w = await courtWeights(env, models);
  const reasons: string[] = [];
  const eligible = models.filter((m) => {
    const x = w[m];
    if (!x?.known) return void reasons.push(`${m}: no reliability record`), false;
    if (x.stale) return void reasons.push(`${m}: record is stale (${x.day})`), false;
    if (x.benched) return void reasons.push(`${m}: benched`), false;
    if (opts.strict && !x.certified) return void reasons.push(`${m}: below C5 targets`), false;
    return true;
  });
  const fams = new Set(eligible.map(judgeFamily));
  if (fams.size < 2) reasons.push(`needs ≥ 2 eligible judges from different families (have ${fams.size})`);
  return { ok: fams.size >= 2, reasons, eligible };
}
