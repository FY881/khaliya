/**
 * Route shapes. index.ts is wired by the integrator, so these tests mount the routes on a bare Hono app exactly as
 * mountRedteamRoutes(app) will (the owner gate in index.ts sits in front of every /api/* route).
 */
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { HANDLERS } from "../../src/jobs/handlers";
import { drainJob } from "../../src/jobs/runner";
import { seedStarterOrg } from "../../src/registry/seed";
import { CATEGORIES, mountRedteamRoutes, registerRedteamHandlers, SEED_ATTACKS } from "../../src/redteam";
import { freshState } from "../helpers";

const E = env as Env;
const T = 110_000;
registerRedteamHandlers(HANDLERS);
beforeEach(freshState);

const app = new Hono<{ Bindings: Env }>();
mountRedteamRoutes(app);
async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await app.request(`https://k.test${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, E);
  return { status: res.status, json: (await res.json()) as any };
}

describe("/api/redteam routes", () => {
  it("GET /attacks lists the seeded library with filters", async () => {
    const all = await call("/api/redteam/attacks?limit=1000");
    expect(all.status).toBe(200);
    expect(all.json.attacks.length).toBe(SEED_ATTACKS.length);
    expect(all.json.attacks[0]).toMatchObject({ id: expect.stringMatching(/^rta_/), category: expect.any(String), lang: expect.any(String), source: "seed", status: "active", spec: { goal: expect.any(Object), expected_safe: expect.any(String) } });
    const ar = await call("/api/redteam/attacks?category=data_exfiltration&lang=ar");
    expect(ar.json.attacks.length).toBe(SEED_ATTACKS.filter((a) => a.category === "data_exfiltration" && a.lang === "ar").length);
  });

  it("POST /campaign validates input and needs targets", async () => {
    expect((await call("/api/redteam/campaign", { method: "POST", body: {} })).status).toBe(409);
    await seedStarterOrg(E);
    const bad = await call("/api/redteam/campaign", { method: "POST", body: { categories: ["nope"] } });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("bad_request");
  });

  it(
    "POST /campaign → 202 job; GET /summary and /breaches report the outcome",
    async () => {
      await seedStarterOrg(E);
      const r = await call("/api/redteam/campaign", { method: "POST", body: { roles: ["auditor"], critic: "auto" } });
      expect(r.status).toBe(202);
      expect(r.json).toMatchObject({ job_id: expect.any(String), reused: false, poll: `/api/jobs/${r.json.job_id}`, job: { kind: "redteam.campaign", status: "queued" } });
      expect(r.json.job.state).toBeUndefined();
      const dup = await call("/api/redteam/campaign", { method: "POST", body: { roles: ["auditor"] } });
      expect(dup.json.reused).toBe(true);
      const j = await drainJob(E, r.json.job_id, 2000);
      expect(j.status).toBe("done");

      const s = await call("/api/redteam/summary");
      expect(s.status).toBe(200);
      expect(s.json.categories.map((c: any) => c.id)).toEqual([...CATEGORIES]);
      expect(s.json.attacks).toMatchObject({ total: SEED_ATTACKS.length, active: SEED_ATTACKS.length });
      expect(s.json.attacks.by_lang.ar).toBeGreaterThanOrEqual(10);
      expect(s.json.regressions.suite).toBe("redteam-core");
      expect(s.json.agents.length).toBe(1);
      const a = s.json.agents[0];
      expect(a).toMatchObject({ role: "auditor", runs: SEED_ATTACKS.length });
      for (const c of CATEGORIES) expect(a.by_category[c]).toMatchObject({ runs: expect.any(Number), passed: expect.any(Number), breached: expect.any(Number), pass_rate: expect.any(Number) });
      expect(s.json.breaches.confirmed).toBe(s.json.regressions.total);
      expect(s.json.campaigns[0]).toMatchObject({ id: r.json.job_id, kind: "redteam.campaign", status: "done" });
      expect(s.json.attackers[0]).toMatchObject({ id: "rt-attacker" });

      const b = await call("/api/redteam/breaches?status=confirmed");
      expect(b.json.breaches.length).toBe(s.json.breaches.confirmed);
      if (b.json.breaches.length) expect(b.json.breaches[0]).toMatchObject({ id: expect.stringMatching(/^rtb_/), status: "confirmed", repro_ok: 2, control_breach: false, regression_id: expect.stringMatching(/^rtr_/), eval_item_id: expect.stringMatching(/^ei_/) });
    },
    T,
  );
});
