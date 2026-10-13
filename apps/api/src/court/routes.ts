/**
 * Owner-only Judge Court API. `mountCourtRoutes(app)` mounts it at /api/court (after the owner gate in index.ts).
 *   GET  /api/court/judges        ?history=14 → {judges:[{model, family, in_panel, record|null, history}], targets, kappa}
 *   POST /api/court/probe         {judges?, kinds?, per_judge?, max_calls?} → 202 {job_id, job, poll, reused}
 *   GET  /api/court/spotchecks    ?status=open|labelled|skipped &lang=en|ar &limit= → {spotchecks, open, kappa}
 *   POST /api/court/spotchecks    {id, label: "A"|"B"|"tie"|"skip"} → {spotcheck, kappa}
 *                                 | {lang, task, answer_a, answer_b, criteria?, judge_verdicts?, reason?} → 201 {spotcheck}
 *   GET  /api/court/weights       ?models=a,b&strict=1 → {weights, gate}
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { labFor } from "../eval/routes";
import { judgeFamily, PROBE_KINDS } from "./probe";
import { startCourtProbe } from "./jobs";
import { courtGate, courtWeights, judgeHistory, latestRecords, refreshScores, TARGETS } from "./score";
import { createSpotCheck, kappaByJudge, labelSpotCheck, listSpotChecks, type Label } from "./store";

type R = { Bindings: Env };
export const courtRoutes = new Hono<R>();

const body = async (c: any) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, any>;

courtRoutes.get("/judges", async (c) => {
  const panel = labFor(c.env, 0).judgeOrder();
  const recs = await latestRecords(c.env);
  const models = [...new Set([...panel, ...recs.map((r) => r.judge_model)])];
  const hist = Math.min(Math.max(0, Number(c.req.query("history") ?? 14) || 0), 60);
  const judges = [];
  for (const m of models) {
    judges.push({
      model: m,
      family: judgeFamily(m),
      in_panel: panel.includes(m),
      record: recs.find((r) => r.judge_model === m) ?? null,
      history: hist ? (await judgeHistory(c.env, m, hist)).map((r) => ({ day: r.day, reliability: r.reliability, weight: r.weight, benched: r.benched, position_consistency: r.position_consistency, self_pref_rate: r.self_pref_rate, lang_consistency: r.lang_consistency })) : [],
    });
  }
  return c.json({ judges, targets: TARGETS, kappa: await kappaByJudge(c.env) });
});

courtRoutes.post("/probe", async (c) => {
  const b = await body(c);
  if (b.kinds !== undefined && (!Array.isArray(b.kinds) || b.kinds.some((k: unknown) => !PROBE_KINDS.includes(k as any)))) return c.json({ error: "invalid", message: `kinds ⊆ ${PROBE_KINDS.join(", ")}` }, 400);
  if (b.judges !== undefined && (!Array.isArray(b.judges) || b.judges.some((j: unknown) => typeof j !== "string"))) return c.json({ error: "invalid", message: "judges must be model ids" }, 400);
  const lab = labFor(c.env, 0);
  const allowed = lab.judgeOrder();
  const judges: string[] | undefined = b.judges?.length ? b.judges : undefined;
  const bad = (judges ?? []).filter((j) => !allowed.includes(j));
  if (bad.length) return c.json({ error: "invalid", message: `not a usable judge model: ${bad.join(", ")}`, usable: allowed }, 400);
  const accepted = await startCourtProbe(c.env, lab, { judges, kinds: b.kinds, per_judge: b.per_judge === undefined ? undefined : Number(b.per_judge), max_calls: b.max_calls === undefined ? undefined : Number(b.max_calls) });
  return c.json(accepted, 202);
});

courtRoutes.get("/spotchecks", async (c) => {
  const status = c.req.query("status") || undefined;
  const lang = c.req.query("lang") || undefined;
  const spotchecks = await listSpotChecks(c.env, { status, lang, limit: Number(c.req.query("limit") ?? 30) || 30 });
  const open = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM court_spotchecks WHERE status = 'open'").first<{ n: number }>())?.n ?? 0;
  return c.json({ spotchecks, open, kappa: await kappaByJudge(c.env) });
});

courtRoutes.post("/spotchecks", async (c) => {
  const b = await body(c);
  if (typeof b.id === "string") {
    if (!["A", "B", "tie", "skip"].includes(b.label)) return c.json({ error: "invalid", message: 'label must be "A" | "B" | "tie" | "skip"' }, 400);
    const s = await labelSpotCheck(c.env, b.id, b.label as Label | "skip");
    if (!s) return c.json({ error: "not_found" }, 404);
    const judges = Object.keys(s.judge_verdicts);
    if (judges.length) await refreshScores(c.env, judges); // kappa feeds reliability; no LLM calls
    return c.json({ spotcheck: s, kappa: await kappaByJudge(c.env) });
  }
  if (!["en", "ar"].includes(b.lang) || typeof b.task !== "string" || typeof b.answer_a !== "string" || typeof b.answer_b !== "string")
    return c.json({ error: "invalid", message: "label {id, label} or create {lang: en|ar, task, answer_a, answer_b, criteria?, judge_verdicts?}" }, 400);
  const jv: Record<string, Label> = {};
  if (b.judge_verdicts && typeof b.judge_verdicts === "object") for (const [k, v] of Object.entries(b.judge_verdicts)) if (["A", "B", "tie"].includes(v as string)) jv[k] = v as Label;
  const s = await createSpotCheck(c.env, { lang: b.lang, task: b.task.slice(0, 2000), answer_a: b.answer_a.slice(0, 4000), answer_b: b.answer_b.slice(0, 4000), criteria: b.criteria, judge_verdicts: jv, reason: typeof b.reason === "string" ? b.reason.slice(0, 200) : "owner" });
  return c.json({ spotcheck: s }, 201);
});

courtRoutes.get("/weights", async (c) => {
  const models = (c.req.query("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const weights = await courtWeights(c.env, models.length ? models : undefined);
  const gate = models.length ? await courtGate(c.env, models, { strict: ["1", "true"].includes(c.req.query("strict") ?? "") }) : null;
  return c.json({ weights, gate });
});

/** Mount at /api/court (call after the owner gate in index.ts). */
export function mountCourtRoutes(app: Hono<any>): void {
  app.route("/api/court", courtRoutes);
}
