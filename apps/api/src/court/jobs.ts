/**
 * Job "court.probe": continuous Judge Court probing in small chunks. Each step runs ONE probe unit (2 judge calls;
 * 4 for 'lang' and 'self_pref'), stores the rows, opens spot-checks for disagreements, and the final step recomputes
 * every probed judge's reliability record. Budget: the job's max_calls (default COURT_PROBE_CALLS) through LabLLM
 * (kill switch → per-job budget → daily lab ledger → router), so probes stay a small share of judge traffic.
 */
import { audit } from "../audit";
import type { Env } from "../env";
import type { LabLLM } from "../eval/llm";
import type { JobHandler } from "../jobs/handlers";
import { jobAccepted, startJob } from "../jobs/routes";
import { fnv1a } from "../eval/text";
import { planUnits, PROBE_KINDS, runUnit, type ProbeKind, type ProbeRow, type ProbeUnit } from "./probe";
import { refreshScores } from "./score";
import { insertProbeRows, upsertSpotCheck } from "./store";

export const COURT_PROBE_KIND = "court.probe";
export const COURT_PROBE_CALLS = 40;

export interface CourtProbeState {
  phase: "probe" | "score" | "done";
  judges: string[];
  units: ProbeUnit[];
  i: number;
  rows: number;
  errors: string[];
  spot: number;
  /** consistent verdicts seen this job per pair: key `${item_key}|${lang}` → {judge: verdict} */
  seen: Record<string, Record<string, string>>;
  scores: { judge: string; reliability: number; weight: number; benched: boolean }[];
}

export function courtProbeInit(judges: string[], opts: { kinds?: string[]; per_judge?: number; seed?: number } = {}): { state: CourtProbeState; total: number } {
  const kinds = (opts.kinds?.length ? PROBE_KINDS.filter((k) => opts.kinds!.includes(k)) : PROBE_KINDS) as ProbeKind[];
  const seed = opts.seed ?? Math.floor(Date.now() / 86_400_000);
  const units = planUnits(judges, kinds, seed, Math.min(Math.max(1, Math.floor(opts.per_judge ?? 6)), 30));
  return { state: { phase: units.length ? "probe" : "score", judges, units, i: 0, rows: 0, errors: [], spot: 0, seen: {}, scores: [] }, total: units.length + 1 };
}

async function spotChecksFor(env: Env, s: CourtProbeState, rows: ProbeRow[], day: string): Promise<number> {
  let opened = 0;
  const open = async (r: ProbeRow, reason: string, sample = false) => {
    if ((await upsertSpotCheck(env, r, reason, { sample })) !== null) opened++;
  };
  for (const r of rows) {
    if (r.probe === "self_pref" || !r.answers) continue;
    if ((r.probe === "gold" || r.probe === "lang") && r.verdict !== "X") await open(r, "judge missed the gold answer");
    const key = `${r.item_key}|${r.lang}`;
    const seen = (s.seen[key] ??= {});
    for (const [other, v] of Object.entries(seen)) {
      if (other !== r.judge_model && v !== r.verdict && (v !== "draw" || r.verdict !== "draw")) {
        await open(r, "judges disagree");
        await open({ ...r, judge_model: other, verdict: v as ProbeRow["verdict"] }, "judges disagree");
      }
    }
    seen[r.judge_model] = r.verdict;
    if ((r.probe === "gold" || r.probe === "lang") && r.verdict === "X" && fnv1a(`${key}|${day}`) % 4 === 0) await open(r, "random sample", true);
  }
  const lang = rows.filter((r) => r.probe === "lang");
  if (lang.length === 2 && lang[0].verdict !== lang[1].verdict) for (const r of lang) await open(r, "EN/AR verdicts differ");
  return opened;
}

export const courtProbeJob: JobHandler<CourtProbeState> = {
  kind: COURT_PROBE_KIND,
  async step(env, lab: LabLLM, job, s) {
    if (s.phase === "probe") {
      const u = s.units[s.i];
      const out = await runUnit(lab, u, s.judges);
      if (out.error) s.errors = [...s.errors, out.error].slice(-20);
      await insertProbeRows(env, out.rows, job.id);
      s.rows += out.rows.length;
      s.spot += await spotChecksFor(env, s, out.rows, new Date().toISOString().slice(0, 10));
      s.i++;
      if (s.i >= s.units.length) s.phase = "score";
      const v = out.rows.map((r) => `${r.lang}:${r.verdict}${r.consistent ? "" : "*"}`).join(" ");
      return { message: `${u.judge} ${u.kind}/${u.item}: ${out.error ? `skipped (${out.error.slice(0, 80)})` : v}` };
    }
    if (s.phase === "score") {
      const recs = await refreshScores(env, s.judges);
      s.scores = recs.map((r) => ({ judge: r.judge_model, reliability: r.reliability, weight: r.weight, benched: r.benched }));
      s.phase = "done";
      return { message: `scored ${recs.length} judges` };
    }
    return { message: "done" };
  },
  isDone: (s) => s.phase === "done",
  progress: (s) => ({ done: s.i + (s.phase === "done" ? 1 : 0), total: s.units.length + 1 }),
  result: (s) => ({ judges: s.judges, units: s.units.length, done: s.i, rows: s.rows, spot_checks: s.spot, errors: s.errors, scores: s.scores }),
  async onFinish(env, job, s, end) {
    // A budget stop after some probes still refreshes the records with what was measured.
    if (end.stopped && s.phase !== "done" && s.rows > 0) {
      try {
        await refreshScores(env, s.judges);
      } catch {}
    }
    await audit(env.DB, job.created_by ?? "owner", "court.probe", job.id, { judges: s.judges, rows: s.rows, spot_checks: s.spot, status: end.status, stopped: end.stopped ?? null, llm_calls: end.llm_calls });
  },
};

/** Start a probe job (owner route / cron). Judges default to every usable judge model (LabLLM.judgeOrder). */
export async function startCourtProbe(env: Env, lab: LabLLM, opts: { judges?: string[]; kinds?: string[]; per_judge?: number; max_calls?: number; created_by?: string } = {}) {
  const judges = opts.judges?.length ? [...new Set(opts.judges)] : lab.judgeOrder();
  const init = courtProbeInit(judges, opts);
  const max_calls = Math.min(Math.max(2, Math.floor(opts.max_calls ?? COURT_PROBE_CALLS)), 300);
  const r = await startJob(env, { kind: COURT_PROBE_KIND, params: { judges, kinds: opts.kinds ?? null, per_judge: opts.per_judge ?? 6 }, state: init.state, total: init.total, max_calls, dedupe_key: COURT_PROBE_KIND });
  return jobAccepted(r.job, r.reused);
}

/** Cron helper: at most one probe job per ~day (skipped under the kill switch by the runner itself). */
export async function scheduleCourtProbe(env: Env, lab: LabLLM): Promise<boolean> {
  const last = await env.DB.prepare("SELECT MAX(created_at) AS at FROM jobs WHERE kind = ?1").bind(COURT_PROBE_KIND).first<{ at: number | null }>();
  if (last?.at && Date.now() - last.at < 20 * 3_600_000) return false;
  await startCourtProbe(env, lab, { created_by: "system:cron" });
  return true;
}
