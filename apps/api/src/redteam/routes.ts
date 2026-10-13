/**
 * Owner-only Red-Team Arena API. mountRedteamRoutes(app) mounts it at /api/redteam (behind index.ts's owner gate and
 * x-khaliya CSRF header, like every other /api/* route).
 *   GET  /api/redteam/summary     library + regression counts, per-agent per-category pass rates, attackers, campaigns
 *   GET  /api/redteam/attacks     ?category=&lang=&source=seed|owner|attacker&status=&limit=  (full specs: owner view)
 *   POST /api/redteam/campaign    {agent_ids?, roles?, categories?, langs?, attack_ids?, generate?, critic?, max_attacks?, max_calls?}
 *                                 → 202 {job_id, reused, job, poll}   ("redteam.campaign" job)
 *   GET  /api/redteam/breaches    ?status=suspected|confirmed|rejected&agent_id=&category=&limit=
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { jobAccepted, startJob } from "../jobs/routes";
import { listJobs, publicJob } from "../jobs/store";
import { newId } from "../util";
import { CampaignError, redteamCampaignInit, REDTEAM_CAMPAIGN_KIND, type CampaignParams } from "./jobs";
import { ensureRedteamSeed, listAttackers, listAttacks, listBreaches, listRegressions, passRates, specOf } from "./store";
import { CATEGORIES, CATEGORY_LABELS, type AttackRow } from "./types";

type R = { Bindings: Env };
export const redteamRoutes = new Hono<R>();

export function attackView(a: AttackRow) {
  return { id: a.id, category: a.category, lang: a.lang, vector: a.vector, title: a.title, difficulty: a.difficulty, source: a.source, attacker_id: a.attacker_id, status: a.status, created_at: a.created_at, spec: specOf(a) };
}

redteamRoutes.get("/summary", async (c) => {
  const env = c.env;
  await ensureRedteamSeed(env);
  const [attacks, regressions, breaches, agents, attackers, jobs] = await Promise.all([
    env.DB.prepare("SELECT category, lang, source, status, COUNT(*) AS n FROM redteam_attacks GROUP BY category, lang, source, status").all<{ category: string; lang: string; source: string; status: string; n: number }>(),
    env.DB.prepare("SELECT category, COUNT(*) AS n FROM redteam_regressions WHERE status = 'active' GROUP BY category").all<{ category: string; n: number }>(),
    env.DB.prepare("SELECT status, category, COUNT(*) AS n FROM redteam_breaches GROUP BY status, category").all<{ status: string; category: string; n: number }>(),
    passRates(env),
    listAttackers(env),
    listJobs(env, { kind: REDTEAM_CAMPAIGN_KIND, limit: 5 }),
  ]);
  const add = (o: Record<string, number>, k: string, n: number) => ((o[k] = (o[k] ?? 0) + n), o);
  const lib = { total: 0, active: 0, by_category: {} as Record<string, number>, by_lang: {} as Record<string, number>, by_source: {} as Record<string, number> };
  for (const r of attacks.results) {
    lib.total += r.n;
    if (r.status === "active") {
      lib.active += r.n;
      add(lib.by_category, r.category, r.n);
      add(lib.by_lang, r.lang, r.n);
      add(lib.by_source, r.source.startsWith("attacker:") ? "attacker" : r.source, r.n);
    }
  }
  const br = { confirmed: 0, suspected: 0, rejected: 0, confirmed_by_category: {} as Record<string, number> };
  for (const r of breaches.results) {
    if (r.status === "confirmed" || r.status === "suspected" || r.status === "rejected") br[r.status] += r.n;
    if (r.status === "confirmed") add(br.confirmed_by_category, r.category, r.n);
  }
  const last = await env.DB.prepare("SELECT MAX(at) AS at FROM redteam_results WHERE kind = 'probe'").first<{ at: number | null }>();
  return c.json({
    categories: CATEGORIES.map((id) => ({ id, ...CATEGORY_LABELS[id] })),
    attacks: lib,
    regressions: { suite: "redteam-core", total: regressions.results.reduce((s, r) => s + r.n, 0), by_category: Object.fromEntries(regressions.results.map((r) => [r.category, r.n])) },
    breaches: br,
    agents,
    attackers: attackers,
    campaigns: jobs.map(publicJob),
    last_probe_at: last?.at ?? null,
  });
});

redteamRoutes.get("/attacks", async (c) => {
  await ensureRedteamSeed(c.env);
  const q = (k: string) => c.req.query(k) || undefined;
  const attacks = await listAttacks(c.env, { category: q("category"), lang: q("lang"), source: q("source"), status: q("status"), limit: Number(q("limit") ?? 200) || 200 });
  return c.json({ attacks: attacks.map(attackView) });
});

redteamRoutes.get("/breaches", async (c) => {
  const q = (k: string) => c.req.query(k) || undefined;
  const breaches = await listBreaches(c.env, { status: q("status"), agent_id: q("agent_id"), category: q("category"), limit: Number(q("limit") ?? 100) || 100 });
  const regs = new Map((await listRegressions(c.env, 2000)).map((r) => [r.id, r.eval_item_id]));
  return c.json({ breaches: breaches.map((b) => ({ ...b, eval_item_id: b.regression_id ? (regs.get(b.regression_id) ?? null) : null })) });
});

redteamRoutes.post("/campaign", async (c) => {
  const body = (await c.req.json<CampaignParams>().catch(() => ({}))) as CampaignParams;
  const id = newId("job");
  let init: Awaited<ReturnType<typeof redteamCampaignInit>>;
  try {
    init = await redteamCampaignInit(c.env, id, body ?? {});
  } catch (e) {
    if (e instanceof CampaignError) return c.json({ error: e.message, code: e.code }, e.code === "bad_request" ? 400 : 409);
    throw e;
  }
  const { job, reused } = await startJob(c.env, { id, kind: REDTEAM_CAMPAIGN_KIND, params: init.params as Record<string, unknown>, state: init.state, total: init.total, max_calls: init.max_calls, dedupe_key: REDTEAM_CAMPAIGN_KIND });
  return c.json(jobAccepted(job, reused), 202);
});

/** Mount at /api/redteam on the main app (call after the owner gate middleware is registered). */
export function mountRedteamRoutes(app: { route: (path: string, r: Hono<any>) => unknown }): void {
  app.route("/api/redteam", redteamRoutes);
}
