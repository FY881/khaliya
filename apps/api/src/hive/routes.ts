/**
 * Owner-only "living hive" feeds, mounted at /api/hive by index.ts.
 *   GET /api/hive/events?since=<ms>&limit=   unified recent event stream for sounds / animations
 *   GET /api/hive/pulse                       compact live counts for the hive map
 *
 * Events are derived, not stored twice: the append-only audit log (promotions, rollbacks, rejections, records,
 * forged tools, kill switch, budget warnings, …) plus the jobs table (job done / failed). Budget warnings are
 * written to the audit log the first time a ledger crosses 80% / 100% of its cap on a day (detected here and
 * by the cron health tick), so every client sees the same event exactly once.
 */
import { Hono } from "hono";
import { audit } from "../audit";
import type { Env } from "../env";
import { Governor } from "../governor/governor";
import { safeJsonParse, today } from "../util";
import { LAB_SHARE } from "../eval/routes";

type R = { Bindings: Env };
export const hiveRoutes = new Hono<R>();

export type Severity = "info" | "success" | "warning" | "critical";
export interface HiveEvent {
  id: string;
  ts: number;
  kind: string;
  severity: Severity;
  title_ar: string;
  title_en: string;
  ref: { type: string; id: string | null; [k: string]: unknown };
  /** Whether the console may celebrate it (sound/animation). Review flags and failures are never "announced" as wins. */
  announce: boolean;
}

type Detail = Record<string, any>;
interface Mapping {
  kind: string;
  severity: Severity | ((d: Detail) => Severity);
  ar: (t: string | null, d: Detail) => string;
  en: (t: string | null, d: Detail) => string;
  ref: string;
  announce?: boolean;
}

const short = (s: string | null | undefined, n = 40) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : "");
const num = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v ?? "—"));

/** audit action → event. Anything not listed is not a hive event. */
export const EVENT_MAP: Record<string, Mapping> = {
  "evolution.promote": { kind: "promotion", severity: "success", ref: "proposal", announce: true, ar: (t) => `ترقية بطل جديد (${short(t, 14)})`, en: (t) => `New champion promoted (${short(t, 14)})` },
  "evolution.auto_rollback": { kind: "rollback", severity: "warning", ref: "proposal", ar: (t) => `تراجع تلقائي عن مرشح (${short(t, 14)})`, en: (t) => `Automatic rollback (${short(t, 14)})` },
  "evolution.owner_rollback": { kind: "rollback", severity: "warning", ref: "proposal", ar: () => "تراجع يدوي من المالك", en: () => "Owner rollback" },
  "evolution.rejected": { kind: "rejection", severity: "info", ref: "proposal", ar: (_t, d) => `رُفض مقترح تطوّر: ${short(d.reason, 60)}`, en: (_t, d) => `Evolution proposal rejected: ${short(d.reason, 60)}` },
  "evolution.lost": { kind: "rejection", severity: "info", ref: "proposal", ar: () => "خسر مرشح البطولة", en: () => "Candidate lost the tournament" },
  "evolution.owner_reject": { kind: "rejection", severity: "info", ref: "proposal", ar: () => "رفض المالك مقترحًا", en: () => "Owner rejected a proposal" },
  "evolution.canary_start": { kind: "canary", severity: "info", ref: "proposal", ar: () => "بدأ اختبار الكناري لمرشح", en: () => "Canary started for a candidate" },
  "discovery.record": {
    kind: "new_record",
    severity: (d) => (d.vs_known === "beats" ? "warning" : "success"),
    ref: "record",
    announce: false, // a candidate is not a record until re-verified twice
    ar: (_t, d) => (d.vs_known === "beats" ? `نتيجة تتخطى المنشور في ${d.problem} — تحتاج مراجعة بشرية` : `رقم مرشّح جديد في ${d.problem}: ${num(d.score)}`),
    en: (_t, d) => (d.vs_known === "beats" ? `Result beyond the published value on ${d.problem} — needs human review` : `New candidate record on ${d.problem}: ${num(d.score)}`),
  },
  "discovery.record_verified": { kind: "record_verified", severity: "success", ref: "record", announce: true, ar: (_t, d) => `رقم موثّق في ${d.problem}: ${num(d.score)}`, en: (_t, d) => `Verified record on ${d.problem}: ${num(d.score)}` },
  "discovery.record_needs_review": {
    kind: "needs_review",
    severity: "warning",
    ref: "record",
    announce: false, // honesty rule: never celebrated, never claimed
    ar: (_t, d) => `${d.problem}: ${num(d.score)} يتخطى المنشور (${num(d.best_known)}) — بانتظار مراجعة بشرية`,
    en: (_t, d) => `${d.problem}: ${num(d.score)} beats the published ${num(d.best_known)} — awaiting human review`,
  },
  "discovery.record_rejected": { kind: "record_rejected", severity: "info", ref: "record", ar: (_t, d) => `فشل التحقق من رقم في ${d.problem}`, en: (_t, d) => `Record failed re-verification on ${d.problem}` },
  "discovery.problem_accepted": { kind: "problem_added", severity: "success", ref: "problem", announce: true, ar: (t) => `مسألة جديدة: ${short(t)}`, en: (t) => `New problem accepted: ${short(t)}` },
  "forge.admitted": { kind: "tool_admitted", severity: "success", ref: "tool", announce: true, ar: (_t, d) => `أداة جديدة دخلت الورشة: ${d.name} v${d.version}`, en: (_t, d) => `Tool admitted: ${d.name} v${d.version}` },
  "forge.rejected": { kind: "tool_rejected", severity: "info", ref: "tool", ar: (_t, d) => `رُفضت أداة: ${d.name ?? ""} — ${short(d.reason, 50)}`, en: (_t, d) => `Tool rejected: ${d.name ?? ""} — ${short(d.reason, 50)}` },
  "forge.retired": { kind: "tool_retired", severity: "info", ref: "tool", ar: (t) => `أُحيلت أداة للتقاعد: ${t}`, en: (t) => `Tool retired: ${t}` },
  "budget.warning": {
    kind: "budget_warning",
    severity: (d) => (d.level >= 100 ? "critical" : "warning"),
    ref: "budget",
    ar: (_t, d) => `الميزانية ${d.scope} (${d.metric}) بلغت ${d.level}%`,
    en: (_t, d) => `Budget ${d.scope} (${d.metric}) reached ${d.level}%`,
  },
  "kill.on": { kind: "kill_switch", severity: "critical", ref: "kill", ar: (t) => (t === "global" ? "تم تفعيل مفتاح الإيقاف الكلي" : `إيقاف ${t}`), en: (t) => (t === "global" ? "Global kill switch ON" : `Stopped ${t}`) },
  "kill.off": { kind: "kill_switch", severity: "info", ref: "kill", ar: (t) => (t === "global" ? "أُلغي الإيقاف الكلي" : `استئناف ${t}`), en: (t) => (t === "global" ? "Global kill switch OFF" : `Resumed ${t}`) },
  "anomaly.autopause": { kind: "agent_paused", severity: "warning", ref: "agent", ar: (t) => `إيقاف تلقائي لوكيل متعثر: ${t}`, en: (t) => `Agent auto-paused: ${t}` },
  "approval.requested": { kind: "approval_requested", severity: "info", ref: "approval", ar: (_t, d) => `طلب موافقة جديد: ${d.tool}`, en: (_t, d) => `Approval requested: ${d.tool}` },
  // P8 red-team arena
  "redteam.campaign": {
    kind: "redteam_campaign",
    severity: (d) => (Number(d.confirmed) > 0 ? "warning" : d.status === "failed" ? "warning" : "info"),
    ref: "job",
    ar: (_t, d) => `انتهت حملة الفريق الأحمر: ${num(d.probes)} هجمة، ${num(d.confirmed)} اختراق مؤكد`,
    en: (_t, d) => `Red-team campaign finished: ${num(d.probes)} probes, ${num(d.confirmed)} confirmed breaches`,
  },
  "redteam.breach_confirmed": {
    kind: "breach_confirmed",
    severity: (d) => (d.severity === "critical" || d.severity === "high" ? "critical" : "warning"),
    ref: "breach",
    announce: false,
    ar: (_t, d) => `اختراق مؤكد (${d.category ?? ""}) على ${short(d.agent, 20) || "وكيل"} — أُضيف اختبار انحدار`,
    en: (_t, d) => `Confirmed breach (${d.category ?? ""}) on ${short(d.agent, 20) || "an agent"} — regression test added`,
  },
  "redteam.breach_rejected": { kind: "breach_rejected", severity: "info", ref: "breach", ar: (_t, d) => `استُبعد اختراق مشتبه (${d.reason ?? ""})`, en: (_t, d) => `Suspected breach dismissed (${d.reason ?? ""})` },
  "redteam.regression_added": { kind: "regression_added", severity: "success", ref: "regression", ar: (_t, d) => `اختبار انحدار جديد من هجوم (${d.category ?? ""})`, en: (_t, d) => `New regression test from an attack (${d.category ?? ""})` },
  "redteam.gate": {
    kind: "redteam_gate",
    severity: (d) => (Number(d.regressions) > 0 ? "warning" : "info"),
    ref: "genome",
    ar: (t, d) => `بوابة الفريق الأحمر لمرشح (${short(t, 14)}): ${num(d.pass)}/${num(d.total)}`,
    en: (t, d) => `Red-team gate for candidate (${short(t, 14)}): ${num(d.pass)}/${num(d.total)}`,
  },
  "evolution.redteam_skipped": { kind: "redteam_skipped", severity: "warning", ref: "genome", ar: (_t, d) => `تخطّي بوابة الفريق الأحمر: ${short(d.reason, 60)}`, en: (_t, d) => `Red-team gate skipped: ${short(d.reason, 60)}` },
  // P5 memory + judge court
  "memory.compact": {
    kind: "memory_compact",
    severity: (d) => (d.status === "failed" ? "warning" : "info"),
    ref: "job",
    ar: () => "اكتملت صيانة ذاكرة المنظمة",
    en: () => "Org memory maintenance finished",
  },
  "court.probe": {
    kind: "court_probe",
    severity: (d) => (d.status === "failed" ? "warning" : Number(d.spot_checks) > 0 ? "warning" : "info"),
    ref: "job",
    ar: (_t, d) => `انتهى فحص محكمة الحكّام: ${num(d.rows)} اختبار، ${num(d.spot_checks)} مراجعة عشوائية`,
    en: (_t, d) => `Judge court probe finished: ${num(d.rows)} probes, ${num(d.spot_checks)} spot-checks`,
  },
  "court.bench": { kind: "judge_benched", severity: "warning", ref: "judge", ar: (t) => `أُوقف حَكَم عن العمل: ${short(t, 30)}`, en: (t) => `Judge benched: ${short(t, 30)}` },
  "court.unbench": { kind: "judge_unbenched", severity: "info", ref: "judge", ar: (t) => `عاد حَكَم للعمل: ${short(t, 30)}`, en: (t) => `Judge reinstated: ${short(t, 30)}` },
  // P16 Agent Studio (audit table)
  "studio.design": {
    kind: "studio_design",
    severity: (d) => (d.status === "failed" ? "warning" : Number(d.promoted) > 0 ? "success" : "info"),
    ref: "job",
    ar: (_t, d) => `انتهى تصميم الاستوديو: ${num(d.promoted)} مُرقّى، ${num(d.rejected)} مرفوض`,
    en: (_t, d) => `Studio design finished: ${num(d.promoted)} promoted, ${num(d.rejected)} rejected`,
  },
  "studio.promote": { kind: "studio_promote", severity: "success", ref: "design", announce: true, ar: (_t, d) => `خدمة جديدة مُرقّاة: ${short(d.slug ?? d.brief, 30)}`, en: (_t, d) => `New service promoted: ${short(d.slug ?? d.brief, 30)}` },
  "studio.reject": { kind: "studio_reject", severity: "info", ref: "design", ar: (_t, d) => `رُفض تصميم ${short(d.brief, 24)}`, en: (_t, d) => `Design rejected: ${short(d.brief, 24)}` },
  "studio.brief.put": { kind: "studio_brief", severity: "info", ref: "brief", ar: (t) => `حُدّث موجز: ${short(t, 24)}`, en: (t) => `Brief updated: ${short(t, 24)}` },
  // P16 the Army (army_audit hash chain; read by /events alongside audit)
  "army.mission.create": { kind: "army_mission", severity: "info", ref: "mission", ar: (t, d) => `مهمة جديدة (${d.risk ?? ""}): ${short(t, 16)}`, en: (t, d) => `New mission (${d.risk ?? ""}): ${short(t, 16)}` },
  "army.mission.approved": { kind: "army_mission", severity: "info", ref: "mission", ar: (t) => `اعتُمدت مهمة ${short(t, 16)}`, en: (t) => `Mission approved ${short(t, 16)}` },
  "army.mission.running": { kind: "army_mission", severity: "info", ref: "mission", ar: (t) => `بدأت مهمة ${short(t, 16)}`, en: (t) => `Mission started ${short(t, 16)}` },
  "army.mission.done": { kind: "army_mission_done", severity: "success", ref: "mission", announce: true, ar: (t) => `اكتملت مهمة ${short(t, 16)}`, en: (t) => `Mission done ${short(t, 16)}` },
  "army.mission.failed": { kind: "army_mission_failed", severity: "warning", ref: "mission", ar: (t) => `فشلت مهمة ${short(t, 16)}`, en: (t) => `Mission failed ${short(t, 16)}` },
  "army.mission.rolled_back": { kind: "army_rollback", severity: "warning", ref: "mission", ar: (t) => `تراجع عن مهمة ${short(t, 16)}`, en: (t) => `Mission rolled back ${short(t, 16)}` },
  "army.swarm.breaker": { kind: "army_breaker", severity: "critical", ref: "mission", ar: (_t, d) => `قاطع السرب: ${num(d.failed)}/${num(d.total)} مهام فرعية فشلت`, en: (_t, d) => `Swarm breaker tripped: ${num(d.failed)}/${num(d.total)} subtasks failed` },
  "army.cap.violation": { kind: "army_violation", severity: "critical", ref: "capability", ar: (_t, d) => `انتهاك صلاحية: ${short(d.tool, 24)}`, en: (_t, d) => `Capability violation: ${short(d.tool, 24)}` },
  "army.kill.on": { kind: "army_kill", severity: "critical", ref: "killswitch", ar: (t) => `مفتاح إيقاف مُفعّل: ${short(t, 30)}`, en: (t) => `Kill switch on: ${short(t, 30)}` },
  "army.kill.off": { kind: "army_kill", severity: "info", ref: "killswitch", ar: (t) => `مفتاح إيقاف مُطفأ: ${short(t, 30)}`, en: (t) => `Kill switch off: ${short(t, 30)}` },
  "army.passport.revoke": { kind: "army_passport", severity: "warning", ref: "passport", ar: (t) => `أُلغي جواز ${short(t, 16)}`, en: (t) => `Passport revoked ${short(t, 16)}` },
  "army.rank.promote": { kind: "army_rank", severity: "success", ref: "agent", ar: (t, d) => `ترقية رتبة ${short(t, 16)} إلى ${d.to ?? ""}`, en: (t, d) => `Rank promotion ${short(t, 16)} → ${d.to ?? ""}` },
  "army.rank.demote": { kind: "army_rank", severity: "warning", ref: "agent", ar: (t, d) => `تخفيض رتبة ${short(t, 16)} إلى ${d.to ?? ""}`, en: (t, d) => `Rank demotion ${short(t, 16)} → ${d.to ?? ""}` },
  "army.incident": { kind: "army_incident", severity: (d) => (d.severity === "critical" || d.severity === "high" ? "critical" : "warning"), ref: "agent", ar: (t, d) => `حادثة ${d.kind ?? ""} لـ ${short(t, 16)}`, en: (t, d) => `Incident ${d.kind ?? ""} for ${short(t, 16)}` },
  "governor.correction": { kind: "governor_correction", severity: "info", ref: "governor", ar: (_t, d) => `تصحيح يدوي لعداد ${d.scope ?? ""} (${d.day ?? ""}): ${num(d.from)} إلى ${num(d.to)}`, en: (_t, d) => `Manual ledger correction ${d.scope ?? ""} (${d.day ?? ""}): ${num(d.from)} -> ${num(d.to)}` },
};

const JOB_TITLES: Record<string, [string, string]> = {
  "eval.seed": ["تهيئة مجموعات التقييم", "Eval seeding"],
  "eval.saturation": ["فحص التشبع", "Saturation check"],
  "evolution.generation": ["جيل تطور", "Evolution generation"],
  "evolution.tick": ["دورة تطور", "Evolution tick"],
  "forge.admit": ["قبول أداة", "Tool admission"],
  "discovery.evolve": ["تطوير برامج الاكتشاف", "Discovery evolution"],
  "discovery.reverify": ["إعادة التحقق من الأرقام", "Record re-verification"],
  "redteam.campaign": ["حملة الفريق الأحمر", "Red-team campaign"],
  "court.probe": ["فحص محكمة الحكّام", "Judge court probe"],
  "memory.compact": ["صيانة الذاكرة", "Memory maintenance"],
  "studio.design": ["تصميم وكلاء الاستوديو", "Studio design"],
  "army.mission": ["مهمة الجيش", "Army mission"],
};

export function auditToEvent(a: { seq: number; at: number; action: string; target: string | null; detail: string | null }): HiveEvent | null {
  const m = EVENT_MAP[a.action];
  if (!m) return null;
  const d = (safeJsonParse<Detail>(a.detail) ?? {}) as Detail;
  return {
    id: `a${a.seq}`,
    ts: a.at,
    kind: m.kind,
    severity: typeof m.severity === "function" ? m.severity(d) : m.severity,
    title_ar: m.ar(a.target, d),
    title_en: m.en(a.target, d),
    ref: { type: m.ref, id: a.target, action: a.action, ...(d.problem ? { problem_id: d.problem } : {}), ...(d.name ? { name: d.name } : {}) },
    announce: !!m.announce,
  };
}

function jobToEvent(j: { id: string; kind: string; status: string; stopped: string | null; error: string | null; finished_at: number; message: string | null }): HiveEvent {
  const [ar, en] = JOB_TITLES[j.kind] ?? [j.kind, j.kind];
  const failed = j.status === "failed";
  const stoppedEarly = j.status === "done" && !!j.stopped;
  return {
    id: `j${j.id}:${j.status}`,
    ts: j.finished_at,
    kind: failed ? "job_failed" : "job_done",
    severity: failed ? "warning" : stoppedEarly ? "info" : "success",
    title_ar: failed ? `فشلت مهمة: ${ar}` : stoppedEarly ? `توقفت مهمة (${j.stopped}): ${ar}` : `اكتملت مهمة: ${ar}`,
    title_en: failed ? `Job failed: ${en}` : stoppedEarly ? `Job stopped (${j.stopped}): ${en}` : `Job done: ${en}`,
    ref: { type: "job", id: j.id, job_kind: j.kind, status: j.status, stopped: j.stopped },
    announce: !failed && !stoppedEarly,
  };
}

export const BUDGET_LEVELS = [80, 100];

/**
 * Write a "budget.warning" audit entry for every ledger that crossed 80% / 100% of its cap today and has not been
 * reported yet. Ledgers: global/provider/model/lab calls, Workers AI neurons, forge sandbox runs.
 */
export async function detectBudgetWarnings(env: Env): Promise<number> {
  const day = today();
  const dayStart = Date.parse(day + "T00:00:00Z");
  const rows =
    (
      await env.DB.prepare(
        "SELECT scope, metric, used, cap FROM budgets WHERE day = ?1 AND cap > 0 AND used * 100 >= cap * ?2 AND (scope IN ('global','lab','forge') OR scope LIKE 'provider:%' OR scope LIKE 'model:%')",
      )
        .bind(day, BUDGET_LEVELS[0])
        .all<{ scope: string; metric: string; used: number; cap: number }>()
    ).results ?? [];
  if (!rows.length) return 0;
  const seen = new Set(
    (
      (await env.DB.prepare("SELECT target FROM audit WHERE action = 'budget.warning' AND at >= ?1").bind(dayStart).all<{ target: string }>()).results ?? []
    ).map((r) => r.target),
  );
  let n = 0;
  for (const r of rows) {
    const pct = (r.used / r.cap) * 100;
    for (const level of BUDGET_LEVELS) {
      if (pct < level) continue;
      const target = `${day}:${r.scope}:${r.metric}:${level}`;
      if (seen.has(target)) continue;
      seen.add(target);
      await audit(env.DB, "governor", "budget.warning", target, { scope: r.scope, metric: r.metric, used: r.used, cap: r.cap, level, pct: Math.round(pct * 10) / 10 });
      n++;
    }
  }
  return n;
}

hiveRoutes.get("/events", async (c) => {
  const now = Date.now();
  const sinceQ = c.req.query("since");
  const since = sinceQ !== undefined && sinceQ !== "" && Number.isFinite(Number(sinceQ)) ? Number(sinceQ) : now - 24 * 3600_000;
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 50) || 50), 200);
  try {
    await detectBudgetWarnings(c.env);
  } catch (e) {
    console.error("budget warning detection failed", e);
  }
  const actions = Object.keys(EVENT_MAP).filter((a) => !a.startsWith("army."));
  const armyActions = Object.keys(EVENT_MAP).filter((a) => a.startsWith("army."));
  // with an explicit `since` the client is paging forward: oldest first; without, the most recent window
  const forward = sinceQ !== undefined && sinceQ !== "";
  const order = forward ? "ASC" : "DESC";
  const [auditRows, jobRows, armyRows] = await Promise.all([
    c.env.DB.prepare(`SELECT seq, at, action, target, detail FROM audit WHERE at > ?1 AND action IN (${actions.map((_, i) => `?${i + 3}`).join(",")}) ORDER BY at ${order}, seq ${order} LIMIT ?2`)
      .bind(since, limit + 1, ...actions)
      .all<{ seq: number; at: number; action: string; target: string | null; detail: string | null }>(),
    c.env.DB.prepare(`SELECT id, kind, status, stopped, error, finished_at, message FROM jobs WHERE finished_at > ?1 AND status IN ('done','failed') ORDER BY finished_at ${order} LIMIT ?2`)
      .bind(since, limit + 1)
      .all<{ id: string; kind: string; status: string; stopped: string | null; error: string | null; finished_at: number; message: string | null }>(),
    // the army's own hash-chained audit (0009_army); absent table before the migration → no army events
    c.env.DB.prepare(`SELECT seq, at, action, target, detail FROM army_audit WHERE at > ?1 AND action IN (${armyActions.map((_, i) => `?${i + 3}`).join(",")}) ORDER BY at ${order}, seq ${order} LIMIT ?2`)
      .bind(since, limit + 1, ...armyActions)
      .all<{ seq: number; at: number; action: string; target: string | null; detail: string | null }>()
      .catch(() => ({ results: [] as { seq: number; at: number; action: string; target: string | null; detail: string | null }[] })),
  ]);
  const all = [...(auditRows.results ?? []).map(auditToEvent).filter((e): e is HiveEvent => !!e), ...(jobRows.results ?? []).map(jobToEvent), ...(armyRows.results ?? []).map((r) => auditToEvent(r)).filter((e): e is HiveEvent => !!e).map((e) => ({ ...e, id: `x${e.id.slice(1)}` }))];
  all.sort((a, b) => (forward ? a.ts - b.ts : b.ts - a.ts) || a.id.localeCompare(b.id));
  const has_more = all.length > limit;
  const page = all.slice(0, limit);
  if (!forward) page.reverse(); // always deliver oldest → newest
  const next_since = page.length ? page[page.length - 1].ts : since;
  return c.json({ events: page, now, next_since, has_more });
});

hiveRoutes.get("/pulse", async (c) => {
  const env = c.env;
  const gov = new Governor(env);
  const day = today();
  const q = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).all<T>().then((r) => r.results ?? []);
  const one = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
  const [caps, kill, killed, agents, jobs, budgets, records, tools, problems, approvals] = await Promise.all([
    gov.caps(),
    gov.isKilled(),
    gov.killedAgents(),
    q<{ role: string; status: string; n: number }>("SELECT role, status, COUNT(*) AS n FROM agents GROUP BY role, status"),
    q<{ kind: string; status: string; n: number }>("SELECT kind, status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') GROUP BY kind, status"),
    q<{ scope: string; metric: string; used: number; cap: number }>("SELECT scope, metric, used, cap FROM budgets WHERE day = ?1", day),
    q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM discovery_records GROUP BY status").catch(() => []),
    q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM forge_tools GROUP BY status").catch(() => []),
    one<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_problems WHERE status = 'active'").catch(() => null),
    one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'"),
  ]);
  const used = (scope: string, metric: string) => budgets.find((b) => b.scope === scope && b.metric === metric)?.used ?? 0;
  const pct = (u: number, cap: number) => (cap > 0 ? Math.round((u / cap) * 1000) / 10 : null);
  const providers: Record<string, { used: number; cap: number; pct: number | null }> = {};
  for (const [p, cap] of Object.entries(caps.provider)) {
    if (p === "mock" && cap === 0) continue;
    providers[p] = { used: used(`provider:${p}`, "llm_calls"), cap, pct: pct(used(`provider:${p}`, "llm_calls"), cap) };
  }
  const labCap = Math.max(1, Math.floor(caps.global.llm_calls * LAB_SHARE));
  const neuronsUsed = used("provider:workers-ai", "neurons");
  const byStatus: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  for (const a of agents) {
    byStatus[a.status] = (byStatus[a.status] ?? 0) + a.n;
    if (a.status !== "retired") byRole[a.role] = (byRole[a.role] ?? 0) + a.n;
  }
  const jobsByKind: Record<string, number> = {};
  let queued = 0;
  let running = 0;
  for (const j of jobs) {
    jobsByKind[j.kind] = (jobsByKind[j.kind] ?? 0) + j.n;
    if (j.status === "queued") queued += j.n;
    else running += j.n;
  }
  const rec = Object.fromEntries(records.map((r) => [r.status, r.n])) as Record<string, number>;
  const tl = Object.fromEntries(tools.map((r) => [r.status, r.n])) as Record<string, number>;
  return c.json({
    ts: Date.now(),
    day,
    kill_global: kill.killed,
    agents: { live: Object.entries(byStatus).filter(([s]) => s !== "retired").reduce((a, [, n]) => a + n, 0), by_status: byStatus, by_role: byRole, killed: killed.length },
    jobs: { active: queued + running, queued, running, by_kind: jobsByKind },
    budget: {
      global: { used: used("global", "llm_calls"), cap: caps.global.llm_calls, pct: pct(used("global", "llm_calls"), caps.global.llm_calls) },
      lab: { used: used("lab", "llm_calls"), cap: labCap, pct: pct(used("lab", "llm_calls"), labCap) },
      providers,
    },
    neurons: { used: neuronsUsed, cap: caps.neurons["workers-ai"], pct: pct(neuronsUsed, caps.neurons["workers-ai"]) },
    records: { total: Object.values(rec).reduce((a, b) => a + b, 0), verified: rec.verified ?? 0, needs_review: rec.beats_known_needs_review ?? 0, candidates: rec.candidate ?? 0, rejected: rec.rejected ?? 0 },
    tools: { admitted: tl.admitted ?? 0, pending: tl.pending ?? 0, rejected: tl.rejected ?? 0, deprecated: tl.deprecated ?? 0 },
    problems: { active: problems?.n ?? 0 },
    pending_approvals: approvals?.n ?? 0,
  });
});
