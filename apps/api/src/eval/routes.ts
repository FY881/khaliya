/**
 * Owner-only Eval Factory API, mounted at /api/evals by index.ts (behind the owner gate + x-khaliya CSRF header).
 * The owner sees everything, including references and checkers. LLM work goes through LabLLM (kill switch,
 * per-request call budget, daily lab ledger, normal router).
 */
import { Hono } from "hono";
import { audit } from "../audit";
import type { Env } from "../env";
import type { Genome } from "../genome/schema";
import { Registry } from "../registry/registry";
import { strongBaseline } from "./baselines";
import { STARTER_SUITES } from "./families";
import { checkSaturation, retireFlaky } from "./ladder";
import { LabLLM } from "./llm";
import { seedEvalSuites } from "./seed";
import { attempt, type SolverGenome } from "./solver";
import { countItems, getItem, getSuite, listItems, listSuites, recordResult, resultsFor, setItemStatus } from "./store";
import type { ItemStatus, Split } from "./types";
import { championGenome } from "./validate";
import { Governor } from "../governor/governor";
import { saturationJobInit, seedJobInit } from "../jobs/handlers";
import { jobAccepted, startJob } from "../jobs/routes";
import { activeJobByKey } from "../jobs/store";

/** Share of the org's daily free LLM calls the lab (eval + evolution) may use. */
export const LAB_SHARE = 0.3;
/** Default per-request LLM call ceilings. */
export const LAB_CALLS = { seed: 4000, saturation: 600, run: 200, author: 80 } as const;

export const labFor = (env: Env, maxCalls: number) => new LabLLM(env, { maxCalls, share: LAB_SHARE });

const clampCalls = (v: unknown, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), def * 5) : def;
};

type R = { Bindings: Env };
export const evalRoutes = new Hono<R>();

// ---------- suites ----------
evalRoutes.get("/suites", async (c) => {
  const suites = await listSuites(c.env);
  const out = await Promise.all(
    suites.map(async (s) => {
      const counts = await countItems(c.env, s.id);
      return { ...s, counts };
    }),
  );
  return c.json({ suites: out });
});

evalRoutes.get("/suites/:id/items", async (c) => {
  const id = c.req.param("id");
  if (!(await getSuite(c.env, id))) return c.json({ error: "not found" }, 404);
  const status = c.req.query("status") as ItemStatus | undefined;
  const split = c.req.query("split") as Split | undefined;
  const limit = Math.min(Number(c.req.query("limit") ?? 1000) || 1000, 5000);
  return c.json({ items: await listItems(c.env, { suite_id: id, status: status || undefined, split: split || undefined, limit }) });
});

evalRoutes.get("/items/:id", async (c) => {
  const item = await getItem(c.env, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  return c.json({ item, validation: item.validation, results: await resultsFor(c.env, item.id, { limit: 500 }) });
});

// ---------- seeding / ladder ----------
/**
 * Seeding and saturation are long (minutes of LLM calls). By default they run as background jobs: the answer is
 * 202 {job_id, job, poll} at once and progress is read from GET /api/jobs/:id. `{"sync": true}` keeps the old
 * single-request behaviour (tests / tiny budgets only — a long sync run can hit the Worker's per-request limits).
 */
evalRoutes.post("/seed", async (c) => {
  const body = await c.req.json<{ suites?: string[]; max_calls?: number; sync?: boolean }>().catch(() => ({}) as { suites?: string[]; max_calls?: number; sync?: boolean });
  let defs = STARTER_SUITES;
  if (Array.isArray(body.suites) && body.suites.length) {
    defs = STARTER_SUITES.filter((s) => body.suites!.includes(s.id));
    if (!defs.length) return c.json({ error: "no known suites in 'suites'", known: STARTER_SUITES.map((s) => s.id) }, 400);
  }
  const maxCalls = clampCalls(body.max_calls, LAB_CALLS.seed);
  if (body.sync === true) {
    const lab = labFor(c.env, maxCalls);
    const summary = await seedEvalSuites(c.env, lab, { suites: defs });
    await audit(c.env.DB, "owner", "eval.seed", null, { suites: defs.map((d) => d.id), created: summary.created, active: summary.active, llm_calls: summary.llm_calls });
    return c.json(summary);
  }
  if ((await new Governor(c.env).isKilled()).killed) return c.json({ error: "global kill switch is ON", code: "lab_killed" }, 423);
  const ids = defs.map((d) => d.id);
  const init = seedJobInit(ids);
  const { job, reused } = await startJob(c.env, { kind: "eval.seed", params: { suites: ids, max_calls: maxCalls }, state: init.state, total: init.total, max_calls: maxCalls, dedupe_key: `eval.seed:${[...ids].sort().join(",")}` });
  return c.json(jobAccepted(job, reused), 202);
});

evalRoutes.post("/suites/:id/saturation", async (c) => {
  const id = c.req.param("id");
  if (!(await getSuite(c.env, id))) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ ladder?: boolean; count?: number; max_calls?: number; sync?: boolean }>().catch(() => ({}) as { ladder?: boolean; count?: number; max_calls?: number; sync?: boolean });
  const maxCalls = clampCalls(body.max_calls, LAB_CALLS.saturation);
  if (body.sync === true) {
    const lab = labFor(c.env, maxCalls);
    const r = await checkSaturation(c.env, lab, id, { ladder: body.ladder, count: body.count });
    await audit(c.env.DB, "owner", "eval.saturation", id, { pass_rate: r.pass_rate, n: r.n, saturated: r.saturated, laddered: !!r.ladder, llm_calls: lab.calls });
    return c.json({ ...r, llm_calls: lab.calls });
  }
  if ((await new Governor(c.env).isKilled()).killed) return c.json({ error: "global kill switch is ON", code: "lab_killed" }, 423);
  const existing = await activeJobByKey(c.env, `eval.saturation:${id}`);
  if (existing) return c.json(jobAccepted(existing, true), 202);
  const init = await saturationJobInit(c.env, id, { ladder: body.ladder, count: body.count });
  const { job, reused } = await startJob(c.env, { kind: "eval.saturation", params: { suite_id: id, ladder: body.ladder ?? true, count: body.count ?? null, max_calls: maxCalls }, state: init.state, total: init.total, max_calls: maxCalls, dedupe_key: `eval.saturation:${id}` });
  return c.json(jobAccepted(job, reused), 202);
});

// ---------- run a genome over the held-out (private) split ----------
evalRoutes.post("/suites/:id/run", async (c) => {
  const id = c.req.param("id");
  const suite = await getSuite(c.env, id);
  if (!suite) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ agent_id?: string; genome_id?: string; max_calls?: number }>().catch(() => ({}) as { agent_id?: string; genome_id?: string; max_calls?: number });
  const reg = new Registry(c.env);
  let genome: SolverGenome | null = null;
  let source = "";
  if (body.genome_id) {
    genome = await reg.getGenome(String(body.genome_id));
    source = "genome";
  } else if (body.agent_id) {
    const a = await reg.getAgent(String(body.agent_id));
    if (!a) return c.json({ error: "agent not found" }, 404);
    genome = await reg.getGenome(a.genome_id);
    source = "agent";
  } else {
    genome = await championGenome(c.env, suite.role);
    source = "champion";
    if (!genome) {
      genome = await strongBaseline(suite.role);
      source = "baseline";
    }
  }
  if (!genome) return c.json({ error: "genome not found" }, 404);
  const lineage = (genome as Partial<Genome>).lineage_id ?? null;

  const all = await listItems(c.env, { suite_id: id, status: "active", split: "private" });
  // Article 6: a lineage is never scored on items it authored.
  const items = lineage ? all.filter((i) => i.author_lineage !== lineage) : all;
  const lab = labFor(c.env, clampCalls(body.max_calls, LAB_CALLS.run));
  const ref = `owner-run:${Date.now()}`;
  const results: { item_id: string; pass: boolean; score: number; difficulty: number }[] = [];
  for (const it of items) {
    const a = await attempt(lab, genome, it);
    await recordResult(c.env, { item_id: it.id, genome_id: genome.id, context: "sandbox", ref, pass: a.verdict.pass, score: a.verdict.score, answer: a.answer, tokens: a.tokens });
    results.push({ item_id: it.id, pass: a.verdict.pass, score: a.verdict.score, difficulty: it.difficulty });
  }
  const passed = results.filter((r) => r.pass).length;
  const n = results.length;
  const out = {
    suite_id: id,
    genome_id: genome.id,
    genome_source: source,
    role: genome.role,
    role_matches_suite: genome.role === suite.role,
    ref,
    n,
    passed,
    pass_rate: n ? Math.round((passed / n) * 1000) / 1000 : 0,
    excluded_own_lineage: all.length - items.length,
    llm_calls: lab.calls,
    results,
  };
  await audit(c.env.DB, "owner", "eval.run", id, { genome_id: genome.id, n, passed, pass_rate: out.pass_rate });
  return c.json(out);
});

// ---------- retirement ----------
evalRoutes.post("/items/:id/retire", async (c) => {
  const item = await getItem(c.env, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const reason = `owner: ${String(body.reason ?? "retired by owner").slice(0, 300)}`;
  await setItemStatus(c.env, item.id, "retired", { reason });
  await audit(c.env.DB, "owner", "eval.item.retire", item.id, { from: item.status, reason });
  return c.json({ item: await getItem(c.env, item.id) });
});

evalRoutes.post("/retire-flaky", async (c) => {
  const body = await c.req.json<{ suite_id?: string }>().catch(() => ({}) as { suite_id?: string });
  if (body.suite_id && !(await getSuite(c.env, body.suite_id))) return c.json({ error: "suite not found" }, 404);
  const r = await retireFlaky(c.env, body.suite_id || undefined);
  await audit(c.env.DB, "owner", "eval.retire_flaky", body.suite_id ?? null, r);
  return c.json(r);
});
