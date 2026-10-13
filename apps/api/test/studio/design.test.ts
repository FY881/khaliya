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
import { decidePromotion, emptyScore, MAX_REFINE_ROUNDS, MOCK_WEAK_CANDIDATE, mountStudioRoutes, STUDIO_BRIEFS, STUDIO_JOB_HANDLERS, toStored } from "../../src/studio";
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
