/**
 * Owner-only Discovery Lab API, mounted at /api/discovery by index.ts (owner session + x-khaliya on writes).
 *   GET  /api/discovery/problems              every problem (built-in + submitted) with its best record and status vs known
 *   GET  /api/discovery/problems/:id          statement, islands, MAP-Elites elites (heatmap), top programs, records, score history
 *   GET  /api/discovery/records               records board; ?status=&problem_id=&limit=
 *   POST /api/discovery/problems/:id/evolve   {generations, llm?, children?, construct_fuel?, verify_fuel?} → 202 job "discovery.evolve"
 *   POST /api/discovery/reverify              {max?} → 202 job "discovery.reverify"
 *   POST /api/discovery/problems              submission (validated: verifier vs known-good/bad, determinism, fuzz, budget, seed) → 201 | 422
 * Honesty rule: a record that beats the published best is 'beats_known_needs_review' — flagged, never announced.
 */
import { Hono } from "hono";
import { audit } from "../audit";
import type { Env } from "../env";
import { Governor } from "../governor/governor";
import { jobAccepted, startJob } from "../jobs/routes";
import { activeJobByKey, publicJob } from "../jobs/store";
import { safeJsonParse } from "../util";
import { evolveJobInit, MAX_EVOLVE_GENERATIONS, MAX_REVERIFY_RECORDS, planFrom, reverifyJobInit } from "./jobs";
import { builtinProblems, getBuiltinProblem } from "./problems";
import { compareToKnown, ensureProblem, getProblemRow, listProblemRows, listRecords, submitProblem, topPrograms, type ProblemRow, type ProblemSubmission, type RecordRow, type Verification } from "./index";
import type { Direction, ProblemDef, RecordStatus, VsKnown } from "./types";

type R = { Bindings: Env };
export const discoveryRoutes = new Hono<R>();

const RECORD_STATUSES: RecordStatus[] = ["candidate", "verified", "beats_known_needs_review", "rejected"];
const evolveKey = (id: string) => `discovery.evolve:${id}`;
const SOLUTION_PREVIEW = 4000;

export function recordView(r: RecordRow, titles?: { title_en: string; title_ar: string }) {
  const verifications = safeJsonParse<Verification[]>(r.verifications) ?? [];
  return {
    id: r.id,
    problem_id: r.problem_id,
    ...(titles ? { title_en: titles.title_en, title_ar: titles.title_ar } : {}),
    score: r.score,
    status: r.status,
    status_reason: r.status_reason,
    vs_known: r.vs_known,
    best_known_score: r.best_known_score,
    verified_count: r.verified_count,
    verifications: verifications.map((v) => ({ seed: v.seed, valid: v.valid, score: v.score, agrees: v.agrees, ms: v.ms, at: v.at })),
    reproducible: r.reproducible === null ? null : !!r.reproducible,
    program_id: r.program_id,
    lineage: r.lineage,
    verifier_hash: r.verifier_hash,
    instance_hash: r.instance_hash,
    eval_seed: r.eval_seed,
    solution_bytes: r.solution.length,
    solution_json: r.solution.length > SOLUTION_PREVIEW ? r.solution.slice(0, SOLUTION_PREVIEW) + "…" : r.solution,
    /** Only verified records are shown/celebrated as records; a beat of the published value is a review flag. */
    announce: r.status === "verified",
    needs_human_review: r.status === "beats_known_needs_review",
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

interface ProblemMeta {
  id: string;
  family: string;
  title_en: string;
  title_ar: string;
  direction: Direction;
  params: Record<string, unknown>;
  best_known: { score: number | null; status: string; source: string };
  tolerance: number;
  source: string;
  status: string;
  generation: number;
  islands: number;
  registered: boolean;
}

function metaFromDef(d: ProblemDef): ProblemMeta {
  return { id: d.id, family: d.family, title_en: d.title_en, title_ar: d.title_ar, direction: d.direction, params: d.params ?? {}, best_known: d.best_known, tolerance: d.tolerance ?? 1e-9, source: d.source ?? "builtin", status: "active", generation: 0, islands: 3, registered: false };
}
function metaFromRow(r: ProblemRow): ProblemMeta {
  return {
    id: r.id,
    family: r.family,
    title_en: r.title_en,
    title_ar: r.title_ar,
    direction: r.direction,
    params: safeJsonParse<Record<string, unknown>>(r.params) ?? {},
    best_known: { score: r.best_known_score, status: r.best_known_status, source: r.best_known_source },
    tolerance: r.tolerance,
    source: r.source,
    status: r.status,
    generation: r.generation,
    islands: r.islands,
    registered: true,
  };
}

async function allProblems(env: Env): Promise<ProblemMeta[]> {
  const rows = await listProblemRows(env);
  const byId = new Map(rows.map((r) => [r.id, metaFromRow(r)]));
  for (const d of builtinProblems()) {
    const m = byId.get(d.id);
    if (!m) byId.set(d.id, metaFromDef(d));
    else byId.set(d.id, { ...m, best_known: d.best_known, title_en: d.title_en, title_ar: d.title_ar }); // the code is the source of truth for built-ins
  }
  return [...byId.values()].sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Best non-rejected record per problem (direction-aware) + counts, in two queries. */
async function recordStats(env: Env) {
  const rows =
    (
      await env.DB.prepare(
        `SELECT r.*, p.direction AS dir FROM discovery_records r JOIN discovery_problems p ON p.id = r.problem_id WHERE r.status != 'rejected' ORDER BY r.created_at ASC`,
      ).all<RecordRow & { dir: Direction }>()
    ).results ?? [];
  const best = new Map<string, RecordRow>();
  const bestVerified = new Map<string, RecordRow>();
  const counts = new Map<string, { total: number; verified: number; needs_review: number; candidate: number }>();
  for (const r of rows) {
    const k = r.problem_id;
    const c = counts.get(k) ?? { total: 0, verified: 0, needs_review: 0, candidate: 0 };
    c.total++;
    if (r.status === "verified") c.verified++;
    else if (r.status === "beats_known_needs_review") c.needs_review++;
    else if (r.status === "candidate") c.candidate++;
    counts.set(k, c);
    const isBetter = (cur?: RecordRow) => !cur || (r.dir === "max" ? r.score > cur.score : r.score < cur.score);
    if (isBetter(best.get(k))) best.set(k, r);
    if ((r.status === "verified" || r.status === "beats_known_needs_review") && isBetter(bestVerified.get(k))) bestVerified.set(k, r);
  }
  const programs =
    (await env.DB.prepare(`SELECT problem_id, COUNT(*) AS n, SUM(valid) AS v FROM discovery_programs GROUP BY problem_id`).all<{ problem_id: string; n: number; v: number }>()).results ?? [];
  return { best, bestVerified, counts, programs: new Map(programs.map((p) => [p.problem_id, { programs: p.n, valid: p.v ?? 0 }])) };
}

/** Relative gap to the published value (0 = matches; >0 = still behind; <0 = beats). null when unknown. */
function gapTo(direction: Direction, score: number | null | undefined, known: number | null): number | null {
  if (score === null || score === undefined || known === null || known === 0) return null;
  const g = direction === "max" ? (known - score) / Math.abs(known) : (score - known) / Math.abs(known);
  return Math.round(g * 1e6) / 1e6;
}

discoveryRoutes.get("/problems", async (c) => {
  const [problems, st] = await Promise.all([allProblems(c.env), recordStats(c.env)]);
  const active = (
    (await c.env.DB.prepare("SELECT id, dedupe_key, status, progress_done, progress_total FROM jobs WHERE kind = 'discovery.evolve' AND status IN ('queued','running')").all<{ id: string; dedupe_key: string; status: string; progress_done: number; progress_total: number }>())
      .results ?? []
  ).reduce((m, j) => m.set(j.dedupe_key, j), new Map<string, { id: string; status: string; progress_done: number; progress_total: number }>());
  const out = problems.map((p) => {
    const b = st.best.get(p.id);
    const bv = st.bestVerified.get(p.id);
    const vs: VsKnown | "none" = b ? compareToKnown(p.direction, b.score, p.best_known.score, p.tolerance) : "none";
    const j = active.get(evolveKey(p.id));
    return {
      ...p,
      best: b ? { record_id: b.id, score: b.score, status: b.status, vs_known: b.vs_known, verified_count: b.verified_count, created_at: b.created_at } : null,
      best_verified: bv ? { record_id: bv.id, score: bv.score, status: bv.status } : null,
      status_vs_known: vs,
      gap: gapTo(p.direction, b?.score, p.best_known.score),
      records: st.counts.get(p.id) ?? { total: 0, verified: 0, needs_review: 0, candidate: 0 },
      programs: st.programs.get(p.id) ?? { programs: 0, valid: 0 },
      job: j ? { id: j.id, status: j.status, done: j.progress_done, total: j.progress_total } : null,
    };
  });
  const summary = {
    problems: out.length,
    with_records: out.filter((p) => p.best).length,
    matches_known: out.filter((p) => p.status_vs_known === "matches").length,
    beats_known_needs_review: out.reduce((a, p) => a + p.records.needs_review, 0),
    verified_records: out.reduce((a, p) => a + p.records.verified, 0),
    running_jobs: out.filter((p) => p.job).length,
  };
  return c.json({ problems: out, summary });
});

/** "s.l.b" → {score_bucket, length_bucket, behaviour}. */
function parseCell(cell: string | null) {
  const [s, l, b] = String(cell ?? "").split(".").map((x) => Number(x));
  return { score_bucket: Number.isFinite(s) ? s : null, length_bucket: Number.isFinite(l) ? l : null, behaviour: Number.isFinite(b) ? b : null };
}

discoveryRoutes.get("/problems/:id", async (c) => {
  const id = c.req.param("id");
  const builtin = getBuiltinProblem(id);
  const row = await getProblemRow(c.env, id);
  if (!builtin && !row) return c.json({ error: "not found" }, 404);
  const meta = row ? { ...metaFromRow(row), ...(builtin ? { best_known: builtin.best_known } : {}) } : metaFromDef(builtin!);
  const def = builtin ?? null;
  const direction = meta.direction;
  const agg = direction === "max" ? "MAX" : "MIN";

  const [islandRows, eliteRows, top, records, hist, job] = await Promise.all([
    c.env.DB.prepare(
      `SELECT island, COUNT(*) AS programs, SUM(valid) AS valid, SUM(elite) AS elites, ${agg}(CASE WHEN valid = 1 THEN score END) AS best FROM discovery_programs WHERE problem_id = ? GROUP BY island ORDER BY island`,
    )
      .bind(id)
      .all<{ island: number; programs: number; valid: number; elites: number; best: number | null }>(),
    c.env.DB.prepare(`SELECT id, island, cell, score, valid, operator, lineage, generation, length(code) AS code_len FROM discovery_programs WHERE problem_id = ? AND elite = 1 ORDER BY island, cell`)
      .bind(id)
      .all<{ id: string; island: number; cell: string | null; score: number | null; valid: number; operator: string; lineage: string | null; generation: number; code_len: number }>(),
    topPrograms(c.env, id, direction, 5),
    listRecords(c.env, { problem_id: id, limit: 50 }),
    c.env.DB.prepare(`SELECT generation, ${agg}(CASE WHEN valid = 1 THEN score END) AS gen_best, COUNT(*) AS evaluated, SUM(valid) AS valid FROM discovery_programs WHERE problem_id = ? GROUP BY generation ORDER BY generation`)
      .bind(id)
      .all<{ generation: number; gen_best: number | null; evaluated: number; valid: number }>(),
    activeJobByKey(c.env, evolveKey(id)),
  ]);

  let running: number | null = null;
  const history = (hist.results ?? []).map((h) => {
    if (h.gen_best !== null && (running === null || (direction === "max" ? h.gen_best > running : h.gen_best < running))) running = h.gen_best;
    return { generation: h.generation, best: running, gen_best: h.gen_best, evaluated: h.evaluated, valid: h.valid ?? 0 };
  });
  const elites = (eliteRows.results ?? []).map((e) => ({ program_id: e.id, island: e.island, cell: e.cell, ...parseCell(e.cell), score: e.score, valid: !!e.valid, operator: e.operator, lineage: e.lineage, generation: e.generation, code_len: e.code_len }));
  const best = records.filter((r) => r.status !== "rejected").sort((a, b) => (direction === "max" ? b.score - a.score : a.score - b.score))[0];

  return c.json({
    problem: {
      ...meta,
      statement_en: row?.statement_en ?? def?.statement_en ?? "",
      statement_ar: row?.statement_ar ?? def?.statement_ar ?? "",
      instance: row ? safeJsonParse(row.instance) : def!.instance,
      verifier: row?.verifier ?? def!.verifier,
      verifier_hash: row?.verifier_hash ?? null,
      seed_program: row?.seed_program ?? def!.seed_program,
      validation: row?.validation ? safeJsonParse(row.validation) : null,
    },
    best: best ? recordView(best) : null,
    status_vs_known: best ? compareToKnown(direction, best.score, meta.best_known.score, meta.tolerance) : "none",
    gap: gapTo(direction, best?.score, meta.best_known.score),
    islands: (islandRows.results ?? []).map((i) => ({ island: i.island, programs: i.programs, valid: i.valid ?? 0, elites: i.elites ?? 0, best: i.best })),
    elites,
    heatmap_axes: { x: "length_bucket", x_buckets: 5, y: "score_bucket", y_buckets: 10, z: "behaviour", z_buckets: 4, note: "score_bucket 0-9 (≈ score/best_known × 8, higher = closer to the published value); length_bucket 0-4 by code size" },
    top_programs: top.map((p) => ({ id: p.id, island: p.island, score: p.score, operator: p.operator, lineage: p.lineage, generation: p.generation, parent_id: p.parent_id, cell: p.cell, code: p.code })),
    records: records.map((r) => recordView(r)),
    history,
    job: job ? publicJob(job) : null,
  });
});

discoveryRoutes.get("/records", async (c) => {
  const status = c.req.query("status") as RecordStatus | undefined;
  if (status && !RECORD_STATUSES.includes(status)) return c.json({ error: "bad status", code: "bad_request" }, 400);
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 50) || 50), 200);
  const rows = await listRecords(c.env, { status, problem_id: c.req.query("problem_id") || undefined, limit });
  const titles = new Map((await allProblems(c.env)).map((p) => [p.id, { title_en: p.title_en, title_ar: p.title_ar }]));
  return c.json({ records: rows.map((r) => recordView(r, titles.get(r.problem_id) ?? { title_en: r.problem_id, title_ar: r.problem_id })) });
});

discoveryRoutes.post("/problems/:id/evolve", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ generations?: number; llm?: string; children?: number; construct_fuel?: number; verify_fuel?: number }>().catch(() => ({}) as Record<string, never>);
  if (!getBuiltinProblem(id) && !(await getProblemRow(c.env, id))) return c.json({ error: "not found" }, 404);
  const gens = Number(body.generations ?? 10);
  if (!Number.isFinite(gens) || gens < 1 || gens > MAX_EVOLVE_GENERATIONS) return c.json({ error: `generations: 1-${MAX_EVOLVE_GENERATIONS}`, code: "bad_request" }, 400);
  if ((await new Governor(c.env).isKilled()).killed) return c.json({ error: "global kill switch is ON", code: "lab_killed" }, 423);
  const { row } = await ensureProblem(c.env, id); // registers / refreshes a built-in
  if (row.status !== "active") return c.json({ error: `problem is ${row.status}`, code: "bad_state" }, 409);
  const plan = planFrom(body);
  const llm = body.llm === "off" ? "off" : "auto";
  const init = evolveJobInit(id, gens, plan, llm);
  const maxCalls = llm === "off" ? 1 : Math.max(1, init.state.generations * plan.children);
  const { job, reused } = await startJob(c.env, { kind: "discovery.evolve", params: { problem_id: id, generations: init.state.generations, llm, plan }, state: init.state, total: init.total, max_calls: maxCalls, dedupe_key: evolveKey(id) });
  return c.json(jobAccepted(job, reused), 202);
});

discoveryRoutes.post("/reverify", async (c) => {
  const body = await c.req.json<{ max?: number }>().catch(() => ({}) as { max?: number });
  if ((await new Governor(c.env).isKilled()).killed) return c.json({ error: "global kill switch is ON", code: "lab_killed" }, 423);
  const init = await reverifyJobInit(c.env, Number(body.max ?? MAX_REVERIFY_RECORDS) || MAX_REVERIFY_RECORDS);
  const { job, reused } = await startJob(c.env, { kind: "discovery.reverify", params: { records: init.state.queue.length }, state: init.state, total: init.total, max_calls: 1, dedupe_key: "discovery.reverify" });
  return c.json(jobAccepted(job, reused), 202);
});

discoveryRoutes.post("/problems", async (c) => {
  const body = await c.req.json<ProblemSubmission>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "JSON object body required", code: "bad_request" }, 400);
  if (typeof body.id === "string" && getBuiltinProblem(body.id)) return c.json({ error: `'${body.id}' is a built-in problem`, code: "conflict" }, 409);
  const s: ProblemSubmission = { ...body, author: "owner" };
  const r = await submitProblem(c.env, s);
  await audit(c.env.DB, "owner", r.status === "accepted" ? "discovery.problem_accepted" : "discovery.problem_rejected", typeof body.id === "string" ? body.id.slice(0, 64) : null, { reason: r.report.reason ?? null, runs: r.report.stats.runs });
  const problem = r.problem ? metaFromRow(r.problem) : null;
  if (r.status === "accepted") return c.json({ status: "accepted", problem, report: r.report }, 201);
  return c.json({ status: "rejected", error: r.report.reason ?? "rejected", problem, report: r.report }, 422);
});
