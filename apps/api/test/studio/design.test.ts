/**
 * End-to-end "studio.design" job in mock mode, through the routes exactly as mountStudioRoutes(app) mounts them
 * (index.ts's owner gate sits in front in production). Handlers are registered here, not in jobs/handlers.ts.
 */
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { HANDLERS } from "../../src/jobs/handlers";
import { drainJob } from "../../src/jobs/runner";
import { Registry } from "../../src/registry/registry";
import { ANSWER_SNIPPET_CHARS, answerSnippet, decidePromotion, emptyScore, MAX_REFINE_ROUNDS, MOCK_WEAK_CANDIDATE, mountStudioRoutes, STUDIO_BRIEFS, STUDIO_JOB_HANDLERS, toStored } from "../../src/studio";
import { freshState } from "../helpers";

const E = env as Env;
Object.assign(HANDLERS, STUDIO_JOB_HANDLERS);
beforeEach(freshState);

const app = new Hono<{ Bindings: Env }>();
mountStudioRoutes(app);
async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await app.request(`https://k.test${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, E);
  return { status: res.status, json: (await res.json()) as any };
}

describe("promotion rule", () => {
  const sc = (cap: [number, number], safety: [number, number]) => ({ ...emptyScore(), cap_pass: cap[0], cap_n: cap[1], safety_pass: safety[0], safety_n: safety[1] });
  it("needs every safety task, capability ≥ 0.75, ≥ strong − 0.1 and > weak", () => {
    expect(decidePromotion({ candidate: sc([4, 4], [1, 1]), strong: sc([4, 4], [0, 1]), weak: sc([0, 4], [0, 1]) }).promote).toBe(true);
    expect(decidePromotion({ candidate: sc([4, 4], [1, 2]), strong: sc([4, 4], [0, 2]), weak: sc([0, 4], [0, 2]) }).reasons.join()).toMatch(/safety/);
    expect(decidePromotion({ candidate: sc([2, 4], [1, 1]), strong: sc([2, 4], [0, 1]), weak: sc([0, 4], [0, 1]) }).reasons.join()).toMatch(/< 0.75/);
    expect(decidePromotion({ candidate: sc([7, 9], [1, 1]), strong: sc([9, 9], [0, 1]), weak: sc([0, 9], [0, 1]) }).reasons.join()).toMatch(/strong/);
    expect(decidePromotion({ candidate: sc([4, 4], [1, 1]), strong: sc([4, 4], [1, 1]), weak: sc([4, 4], [0, 1]) }).reasons.join()).toMatch(/weak/);
    expect(decidePromotion({ candidate: sc([4, 4], [0, 0]), strong: sc([4, 4], [0, 0]), weak: sc([0, 4], [0, 0]) }).promote).toBe(false);
  });
});

describe("answer snippets", () => {
  it("truncates and scrubs credential-looking strings", () => {
    const long = "ا".repeat(ANSWER_SNIPPET_CHARS + 50);
    const a = answerSnippet(long);
    expect(a).toMatchObject({ truncated: true, chars: ANSWER_SNIPPET_CHARS + 50 });
    expect(a.text.length).toBe(ANSWER_SNIPPET_CHARS + 1);
    const k = "AIza" + "B".repeat(35);
    expect(answerSnippet(`key ${k} end`).text).toBe("key [redacted] end");
    expect(answerSnippet("ghp_" + "x".repeat(36)).text).toBe("[redacted]");
    expect(answerSnippet(null)).toEqual({ text: "", truncated: false, chars: 0 });
  });
});

describe("/api/studio + studio.design job (mock)", () => {
  it("GET /briefs seeds lazily; POST /briefs validates and stores owner briefs", async () => {
    const r = await call("/api/studio/briefs");
    expect(r.status).toBe(200);
    expect(r.json.briefs).toHaveLength(12);
    expect(r.json.briefs[0]).toMatchObject({ id: expect.any(String), title_ar: expect.any(String), source: "seed", tasks: expect.any(Number), safety_tasks: expect.any(Number), latest_design: null });
    expect((await call("/api/studio/briefs", { method: "POST", body: { id: "x" } })).status).toBe(400);
    expect((await call("/api/studio/briefs", { method: "POST", body: { ...toStored(STUDIO_BRIEFS[0]) } })).status).toBe(409);
    const own = { ...toStored(STUDIO_BRIEFS[1]), id: "my-tutor", service: { ...STUDIO_BRIEFS[1].service, slug: "my-tutor" } };
    const p = await call("/api/studio/briefs", { method: "POST", body: own });
    expect(p.status).toBe(201);
    expect(p.json.brief).toMatchObject({ id: "my-tutor", source: "owner" });
    expect((await call("/api/studio/briefs", { method: "POST", body: own })).status).toBe(200);
    expect((await call("/api/studio/briefs")).json.briefs).toHaveLength(13);
    expect((await call("/api/studio/briefs/nope/design", { method: "POST" })).status).toBe(404);
  });

  it(
    "design-all promotes all 12 agents: registry genomes, service_versions, paused private suites, no deploy",
    async () => {
      const r = await call("/api/studio/design-all", { method: "POST" });
      expect(r.status).toBe(202);
      expect(r.json).toMatchObject({ job_id: expect.any(String), reused: false, poll: `/api/jobs/${r.json.job_id}`, job: { kind: "studio.design", status: "queued" } });
      expect((await call("/api/studio/design-all", { method: "POST" })).json.reused).toBe(true);
      const j = await drainJob(E, r.json.job_id, 3000);
      expect(j.status).toBe("done");
      expect(j.stopped).toBeNull();
      const res = j.result as any;
      const table = res.results.map((x: any) => `${x.brief_id}: ${x.status} cand=${x.candidate?.cap_rate}/${x.candidate?.safety_rate} strong=${x.strong?.cap_rate}/${x.strong?.safety_rate} weak=${x.weak?.cap_rate}/${x.weak?.safety_rate}`);
      console.log(`STUDIO_RESULTS llm_calls=${res.llm_calls}\n${table.join("\n")}`);
      expect(res.promoted.sort()).toEqual(STUDIO_BRIEFS.map((b) => b.id).sort());
      for (const x of res.results) {
        expect(x.candidate).toEqual({ cap_rate: 1, safety_rate: 1 });
        expect(x.weak.cap_rate).toBe(0);
        expect(x.service_version).toBe(1);
      }

      const designs = (await call("/api/studio/designs?status=promoted&limit=100")).json.designs;
      expect(designs).toHaveLength(12);
      const one = (await call(`/api/studio/designs/${designs[0].id}`)).json.design;
      expect(one).toMatchObject({ status: "promoted", genome_id: expect.any(String), promoted_at: expect.any(Number), report: { genome: expect.any(Object), scores: expect.any(Object), decision: { promote: true } } });
      expect((await call("/api/studio/designs/sd_nope")).status).toBe(404);

      const reg = new Registry(E);
      for (const d of designs) {
        const g = await reg.getGenome(d.genome_id);
        expect(g?.lineage_id).toBe(`studio-${d.brief_id}`);
      }
      // Never deployed: no agent rows were created for the designed genomes.
      const agents = await E.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE genome_id IN (SELECT genome_id FROM studio_designs)").first<{ n: number }>();
      expect(agents!.n).toBe(0);
      const sv = await E.DB.prepare("SELECT COUNT(*) AS n FROM service_versions").first<{ n: number }>();
      expect(sv!.n).toBe(12);
      const suites = await E.DB.prepare("SELECT status, COUNT(*) AS n FROM eval_suites WHERE id LIKE 'studio-%' GROUP BY status").all<{ status: string; n: number }>();
      expect(suites.results).toEqual([{ status: "paused", n: 12 }]);
      const items = await E.DB.prepare("SELECT split, status, COUNT(*) AS n FROM eval_items WHERE suite_id LIKE 'studio-%' GROUP BY split, status").all<{ split: string; status: string; n: number }>();
      expect(items.results).toEqual([{ split: "private", status: "active", n: STUDIO_BRIEFS.reduce((a, b) => a + b.tasks.length, 0) }]);

      const briefs = (await call("/api/studio/briefs")).json.briefs;
      expect(briefs.every((b: any) => b.latest_design?.status === "promoted")).toBe(true);
    },
    115_000,
  );

  it(
    "rejects a design whose candidate is not better than the baselines (and versions designs per brief)",
    async () => {
      const seed = STUDIO_BRIEFS.find((b) => b.id === "hijri-helper")!;
      const weakBrief = { ...toStored(seed), id: "weak-hijri", playbook: [...seed.playbook, MOCK_WEAK_CANDIDATE], service: { ...seed.service, slug: "weak-hijri" } };
      expect((await call("/api/studio/briefs", { method: "POST", body: weakBrief })).status).toBe(201);
      const r = await call("/api/studio/briefs/weak-hijri/design", { method: "POST" });
      expect(r.status).toBe(202);
      const j = await drainJob(E, r.json.job_id, 500);
      const res = j.result as any;
      expect(res.rejected).toEqual(["weak-hijri"]);
      // owner briefs carry no mock behaviours: the candidate answers generically, so capability is 0
      expect(res.results[0].reasons.join(" ")).toMatch(/capability/);
      // a failing candidate is refined from abstract feedback up to MAX_REFINE_ROUNDS times, never more
      expect(res.results[0].rounds).toBe(MAX_REFINE_ROUNDS);
      expect(res.llm_calls).toBeLessThanOrEqual(90);
      const d = (await call("/api/studio/designs?brief_id=weak-hijri")).json.designs;
      expect(d).toHaveLength(1);
      expect(d[0].status).toBe("rejected");
      const full = (await call(`/api/studio/designs/${d[0].id}`)).json.design;
      expect(full.report.revisions).toHaveLength(MAX_REFINE_ROUNDS);
      expect(full.report.history).toHaveLength(MAX_REFINE_ROUNDS);
      expect(full.report.genome.system_prompt).toContain(`REVISION NOTES (round ${MAX_REFINE_ROUNDS})`);
      expect(full.genome_id).toBe(full.report.revisions[MAX_REFINE_ROUNDS - 1].genome_id);
      // strong / weak were evaluated once; later rounds re-ran the candidate only
      const arms = full.report.outcomes.reduce((m: Record<string, number>, o: any) => ((m[o.arm] = (m[o.arm] ?? 0) + 1), m), {});
      expect(arms.strong).toBe(arms.weak);
      expect(arms.candidate).toBe(arms.strong * (MAX_REFINE_ROUNDS + 1));
      expect(j.progress?.done ?? 0).toBeLessThanOrEqual(j.progress?.total ?? Infinity);
      expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM service_versions").first<{ n: number }>())!.n).toBe(0);
      // per-item answers are stored (truncated) in the owner-only report, one per (item × arm × round), with rounds
      const ans = full.report.item_answers as any[];
      expect(ans).toHaveLength(full.report.outcomes.length);
      expect(ans.every((a) => typeof a.answer === "string" && a.answer.length <= ANSWER_SNIPPET_CHARS + 1 && typeof a.key === "string")).toBe(true);
      expect(new Set(ans.filter((a) => a.arm === "candidate").map((a) => a.round))).toEqual(new Set(Array.from({ length: MAX_REFINE_ROUNDS + 1 }, (_, i) => i)));
      expect(ans.filter((a) => a.arm !== "candidate").every((a) => a.round === 0)).toBe(true);
      expect(ans.filter((a) => !a.pass).every((a) => a.detail === null || typeof a.detail === "string")).toBe(true);

      const r2 = await call("/api/studio/briefs/hijri-helper/design", { method: "POST" });
      const j2 = await drainJob(E, r2.json.job_id, 500);
      expect((j2.result as any).promoted).toEqual(["hijri-helper"]);
      const r3 = await call("/api/studio/briefs/hijri-helper/design", { method: "POST" });
      const j3 = await drainJob(E, r3.json.job_id, 500);
      expect((j3.result as any).promoted).toEqual(["hijri-helper"]);
      const versions = (await call("/api/studio/designs?brief_id=hijri-helper")).json.designs.map((x: any) => x.version).sort();
      expect(versions).toEqual([1, 2]);
      const sv = await E.DB.prepare("SELECT version FROM service_versions WHERE slug = 'hijri-helper' ORDER BY version").all<{ version: number }>();
      expect(sv.results.map((x) => x.version)).toEqual([1, 2]);
    },
    110_000,
  );
});

describe("studio re-evaluation + task validation (mock)", () => {
  it(
    "reeval keeps a promoted genome that still meets the gate and flags one that no longer does",
    async () => {
      expect((await call("/api/studio/reeval", { method: "POST", body: {} })).status).toBe(400);
      const none = await call("/api/studio/reeval", { method: "POST", body: { brief_ids: ["hijri-helper"] } });
      const j0 = await drainJob(E, none.json.job_id, 200);
      expect((j0.result as any).failed).toEqual(["hijri-helper"]);

      const d = await call("/api/studio/briefs/hijri-helper/design", { method: "POST" });
      expect(((await drainJob(E, d.json.job_id, 500)).result as any).promoted).toEqual(["hijri-helper"]);
      const svBefore = (await E.DB.prepare("SELECT COUNT(*) AS n FROM service_versions").first<{ n: number }>())!.n;

      const r = await call("/api/studio/reeval", { method: "POST", body: { brief_ids: ["hijri-helper"] } });
      expect(r.status).toBe(202);
      const j = await drainJob(E, r.json.job_id, 500);
      const res = j.result as any;
      expect(res).toMatchObject({ mode: "reeval", kept: ["hijri-helper"], flagged: [] });
      expect(res.results[0].reeval.verdict).toBe("kept");
      expect(res.llm_calls).toBeLessThanOrEqual(60);
      const promoted = (await call("/api/studio/designs?brief_id=hijri-helper&status=promoted")).json.designs;
      const orig = promoted.find((x: any) => x.id === res.results[0].reeval.of_design);
      expect(orig).toBeTruthy();
      const re = (await call(`/api/studio/designs/${res.results[0].design_id}`)).json.design;
      expect(re.genome_id).toBe(orig.genome_id); // same genome, no new architect draft
      expect(re.report.kind).toBe("reeval");
      expect(re.report.item_answers.length).toBe(re.report.outcomes.length);
      expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM service_versions").first<{ n: number }>())!.n).toBe(svBefore); // no new version

      // make the promoted genome answer badly (as if the suite had become harder for it) → flagged, not kept
      const row = await E.DB.prepare("SELECT report FROM studio_designs WHERE id = ?1").bind(orig.id).first<{ report: string }>();
      const rep = JSON.parse(row!.report);
      rep.genome.system_prompt += `\n${MOCK_WEAK_CANDIDATE}`;
      await E.DB.prepare("UPDATE studio_designs SET report = ?2 WHERE id = ?1").bind(orig.id, JSON.stringify(rep)).run();
      const r2 = await call("/api/studio/reeval", { method: "POST", body: { brief_ids: ["hijri-helper"] } });
      const j2 = await drainJob(E, r2.json.job_id, 500);
      const res2 = j2.result as any;
      expect(res2).toMatchObject({ kept: [], flagged: ["hijri-helper"], rejected: ["hijri-helper"] });
      expect(res2.results[0].reeval.of_design).toBe(orig.id); // a re-eval row is never itself re-evaluated
      const flag = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'studio.flag'").first<{ n: number }>().catch(() => null);
      if (flag) expect(flag.n).toBeGreaterThanOrEqual(1);
      const briefs = (await call("/api/studio/briefs")).json.briefs;
      expect(briefs.find((b: any) => b.id === "hijri-helper").latest_design.status).toBe("rejected");
    },
    60_000,
  );

  it("validate-task runs the Eval Factory gates without storing the item", async () => {
    expect((await call("/api/studio/briefs/nope/validate-task", { method: "POST", body: { key: "x" } })).status).toBe(404);
    expect((await call("/api/studio/briefs/hijri-helper/validate-task", { method: "POST", body: { key: "nope" } })).status).toBe(404);
    const before = (await E.DB.prepare("SELECT COUNT(*) AS n FROM eval_items").first<{ n: number }>())!.n;
    const r = await call("/api/studio/briefs/hijri-helper/validate-task", { method: "POST", body: { key: "day_of_year", max_calls: 15 } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ brief_id: "hijri-helper", key: "day_of_year", status: expect.stringMatching(/active|reserve|rejected/) });
    const gate = (g: string) => r.json.gates.find((x: any) => x.gate === g);
    expect(gate("structure").pass).toBe(true);
    expect(gate("solvable").pass).toBe(true);
    expect(gate("anti_gaming").pass).toBe(true);
    expect(r.json.llm_calls).toBeLessThanOrEqual(15);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM eval_items").first<{ n: number }>())!.n).toBe(before);
  });
});
