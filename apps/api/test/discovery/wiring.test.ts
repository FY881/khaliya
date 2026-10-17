import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getProblemRow, insertRecord, listRecords } from "../../src/discovery/store";
import type { Env } from "../../src/env";
import { drainJob } from "../../src/jobs/runner";
import { today } from "../../src/util";
import { api, freshState, login } from "../helpers";

const E = env as unknown as Env;
const T = 90_000;
beforeEach(freshState);

const TOY_VERIFIER = `function verify(x) {
  var s = x.solution;
  if (!Array.isArray(s)) return { valid: false, detail: "need an array" };
  if (s.length > x.instance.cap) return { valid: false, detail: "too long" };
  var t = 0;
  for (var i = 0; i < s.length; i++) {
    if (typeof s[i] !== "number" || s[i] < 0 || s[i] > 3) return { valid: false, detail: "values 0..3" };
    t += s[i];
  }
  return { valid: true, score: t, detail: "sum " + t };
}`;
const toy = (over: Record<string, unknown> = {}) => ({
  id: "toy-sum",
  title_en: "Toy sum",
  statement_en: "Pick at most cap numbers in 0..3 with the largest sum.",
  direction: "max",
  instance: { cap: 4 },
  verifier: TOY_VERIFIER,
  seed_program: "function construct(input) { return [3, 3]; }",
  best_known: { score: 5, source: "toy (deliberately low, for tests)" },
  good: [[1, 2], [3, 3]],
  bad: ["x", [9]],
  ...over,
});

describe("Discovery Lab API + jobs", () => {
  it("GET /api/discovery/problems lists every built-in (registered or not) with status vs known", async () => {
    const cookie = await login();
    const r = await api(cookie, "/api/discovery/problems");
    expect(r.status).toBe(200);
    expect(r.json.problems.length).toBeGreaterThanOrEqual(22);
    const g = r.json.problems.find((p: any) => p.id === "golomb-10");
    expect(g).toMatchObject({ family: expect.any(String), direction: "min", best_known: { score: 55 }, best: null, status_vs_known: "none", registered: false, job: null });
    expect(g.title_ar).toBeTruthy();
    expect(r.json.summary).toMatchObject({ problems: r.json.problems.length, with_records: 0 });
  });

  it("POST evolve → 202 job; one generation per chunk (free plan); records re-verified; detail has islands/elites/history", { timeout: T }, async () => {
    const cookie = await login();
    const r = await api(cookie, "/api/discovery/problems/golomb-10/evolve", { method: "POST", body: { generations: 6 } });
    expect(r.status).toBe(202);
    expect(r.json.job).toMatchObject({ kind: "discovery.evolve", status: expect.stringMatching(/queued|running/) });
    const again = await api(cookie, "/api/discovery/problems/golomb-10/evolve", { method: "POST", body: { generations: 6 } });
    expect(again.json.reused || again.json.job.status === "done").toBe(true);
    const job = await drainJob(E, r.json.job_id);
    expect(job.status).toBe("done");
    const res = job.result as any;
    expect(res.generations_done).toBe(6);
    expect(job.chunks).toBeGreaterThanOrEqual(6);
    expect(res.history).toHaveLength(6);
    expect(res.best).not.toBeNull();
    expect(res.best).toBeGreaterThanOrEqual(55); // never below the proven optimum
    expect((await getProblemRow(E, "golomb-10"))!.generation).toBe(6);

    const recs = await listRecords(E, { problem_id: "golomb-10" });
    expect(recs.length).toBe(res.records.length);
    expect(recs.length).toBeGreaterThan(0);
    // the job's reverify phase gave every record its two independent checks
    expect(recs.every((x) => x.status === "verified" && x.verified_count === 2)).toBe(true);

    const d = await api(cookie, "/api/discovery/problems/golomb-10");
    expect(d.status).toBe(200);
    expect(d.json.problem).toMatchObject({ id: "golomb-10", registered: true, generation: 6 });
    expect(d.json.problem.verifier).toContain("function verify");
    expect(d.json.islands.length).toBeGreaterThan(0);
    expect(d.json.elites.length).toBeGreaterThan(0);
    const e0 = d.json.elites.find((e: any) => e.valid);
    expect(e0).toMatchObject({ score_bucket: expect.any(Number), length_bucket: expect.any(Number), behaviour: expect.any(Number) });
    expect(d.json.heatmap_axes).toMatchObject({ x_buckets: 5, y_buckets: 10 });
    expect(d.json.top_programs[0].code).toContain("construct");
    // detail history groups STORED programs by generation; the job seed comes from the random job id, so a
    // generation whose children were all duplicates/invalid can leave no row (CI saw 5 of 6 on 2026-10-17)
    expect(d.json.history.length).toBeGreaterThanOrEqual(1);
    expect(d.json.history.length).toBeLessThanOrEqual(7);
    expect(new Set(d.json.history.map((h: any) => h.generation)).size).toBe(d.json.history.length);
    // running best is monotone (min problem)
    const bests = d.json.history.map((h: any) => h.best).filter((b: any) => b !== null);
    for (let i = 1; i < bests.length; i++) expect(bests[i]).toBeLessThanOrEqual(bests[i - 1]);
    expect(d.json.best).toMatchObject({ status: "verified", announce: true, needs_human_review: false });
    expect(["below", "matches"]).toContain(d.json.status_vs_known);

    const list = await api(cookie, "/api/discovery/problems");
    expect(list.json.problems.find((p: any) => p.id === "golomb-10")).toMatchObject({ registered: true, records: { verified: recs.length }, best: { status: "verified" } });

    const board = await api(cookie, "/api/discovery/records?status=verified");
    expect(board.json.records.length).toBe(recs.length);
    expect(board.json.records[0]).toMatchObject({ problem_id: "golomb-10", title_en: expect.any(String), announce: true, verifications: expect.any(Array) });

    const ev = await api(cookie, "/api/hive/events?limit=200");
    const kinds = ev.json.events.map((e: any) => e.kind);
    expect(kinds).toContain("new_record");
    expect(kinds).toContain("record_verified");
    expect(ev.json.events.find((e: any) => e.kind === "new_record").announce).toBe(false);
  });

  it("evolve validation: 404 unknown, 400 bad generations, 423 under the kill switch", { timeout: T }, async () => {
    const cookie = await login();
    expect((await api(cookie, "/api/discovery/problems/nope-1/evolve", { method: "POST", body: { generations: 2 } })).status).toBe(404);
    expect((await api(cookie, "/api/discovery/problems/golomb-10/evolve", { method: "POST", body: { generations: 0 } })).status).toBe(400);
    expect((await api(cookie, "/api/discovery/problems/golomb-10/evolve", { method: "POST", body: { generations: 999 } })).status).toBe(400);
    expect((await api(cookie, "/api/discovery/problems/nope")).status).toBe(404);
    await api(cookie, "/api/governor/kill", { method: "POST", body: { on: true } });
    expect((await api(cookie, "/api/discovery/problems/golomb-10/evolve", { method: "POST", body: { generations: 2 } })).status).toBe(423);
    expect((await api(cookie, "/api/discovery/reverify", { method: "POST", body: {} })).status).toBe(423);
    const ev = await api(cookie, "/api/hive/events");
    expect(ev.json.events.find((e: any) => e.kind === "kill_switch")).toMatchObject({ severity: "critical", title_en: "Global kill switch ON" });
  });

  it("problem submission is validated; a beat of the published value is flagged for review and never announced", { timeout: T }, async () => {
    const cookie = await login();
    const builtin = await api(cookie, "/api/discovery/problems", { method: "POST", body: toy({ id: "golomb-10" }) });
    expect(builtin.status).toBe(409);
    const badV = await api(cookie, "/api/discovery/problems", { method: "POST", body: toy({ id: "toy-bad", bad: [[1, 1], [9]] }) });
    expect(badV.status).toBe(422);
    expect(badV.json.report.reason).toMatch(/^bad:/);
    const ok = await api(cookie, "/api/discovery/problems", { method: "POST", body: toy() });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ status: "accepted", problem: { id: "toy-sum", source: "owner", status: "active" } });
    expect(ok.json.report.warnings.join(" ")).toMatch(/already beats/);

    // a certificate beating the (deliberately low) published value
    const row = (await getProblemRow(E, "toy-sum"))!;
    const rec = await insertRecord(E, row, { score: 6, program_id: null, solution: [3, 3], verifier_hash: row.verifier_hash, eval_seed: 1, lineage: "test" });
    expect(rec.vs_known).toBe("beats");
    const rv = await api(cookie, "/api/discovery/reverify", { method: "POST", body: {} });
    expect(rv.status).toBe(202);
    const job = await drainJob(E, rv.json.job_id);
    expect(job.result).toMatchObject({ records: 1, counts: { beats_known_needs_review: 1 } });

    const board = await api(cookie, "/api/discovery/records");
    const r0 = board.json.records.find((r: any) => r.id === rec.id);
    expect(r0).toMatchObject({ status: "beats_known_needs_review", announce: false, needs_human_review: true, verified_count: 2 });
    const ev = await api(cookie, "/api/hive/events?limit=200");
    const flag = ev.json.events.find((e: any) => e.kind === "needs_review");
    expect(flag).toMatchObject({ severity: "warning", announce: false });
    expect(flag.title_en).toMatch(/awaiting human review/);
    expect(ev.json.events.some((e: any) => e.kind === "record_verified")).toBe(false);
    const pulse = await api(cookie, "/api/hive/pulse");
    expect(pulse.json.records).toMatchObject({ needs_review: 1, verified: 0 });
  });
});

describe("hive feeds", () => {
  it("events: since-paging (oldest → newest), budget warnings once per level, pulse shape", { timeout: T }, async () => {
    const cookie = await login();
    const t0 = Date.now() - 1;
    await api(cookie, "/api/governor/kill", { method: "POST", body: { on: true } });
    await api(cookie, "/api/governor/kill", { method: "POST", body: { on: false } });
    await E.DB.prepare("INSERT INTO budgets (day, scope, metric, used, cap) VALUES (?1, 'lab', 'llm_calls', 85, 100)").bind(today()).run();
    const a = await api(cookie, `/api/hive/events?since=${t0}&limit=2`);
    expect(a.status).toBe(200);
    expect(a.json.events).toHaveLength(2);
    expect(a.json.has_more).toBe(true);
    expect(a.json.events[0].ts).toBeLessThanOrEqual(a.json.events[1].ts);
    for (const e of a.json.events) expect(e).toMatchObject({ id: expect.any(String), ts: expect.any(Number), kind: expect.any(String), severity: expect.any(String), title_ar: expect.any(String), title_en: expect.any(String), ref: expect.any(Object) });
    const b = await api(cookie, `/api/hive/events?since=${t0}&limit=50`);
    const budget = b.json.events.filter((e: any) => e.kind === "budget_warning");
    expect(budget).toHaveLength(1);
    expect(budget[0]).toMatchObject({ severity: "warning", ref: { type: "budget" } });
    expect(budget[0].title_en).toMatch(/lab .*80%/);
    await E.DB.prepare("UPDATE budgets SET used = 100 WHERE scope = 'lab'").run();
    const c = await api(cookie, `/api/hive/events?since=${b.json.next_since}`);
    expect(c.json.events.map((e: any) => [e.kind, e.severity])).toEqual([["budget_warning", "critical"]]);

    const p = await api(cookie, "/api/hive/pulse");
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({
      ts: expect.any(Number),
      kill_global: false,
      agents: { live: expect.any(Number), by_status: expect.any(Object), by_role: expect.any(Object), killed: 0 },
      jobs: { active: 0, queued: 0, running: 0 },
      budget: { global: { cap: expect.any(Number) }, lab: { used: 100 }, providers: expect.any(Object) },
      neurons: { cap: expect.any(Number) },
      records: { total: 0 },
      tools: { admitted: 0 },
      problems: { active: 0 },
      pending_approvals: 0,
    });
    expect(p.json.budget.lab.pct).toBeGreaterThan(0);
  });
});
