/** Arena + "redteam.campaign" job against the seeded starter org, in mock mode. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../../src/audit";
import { CONSTITUTION } from "../../src/constitution";
import type { Env } from "../../src/env";
import { getItem, getSuite } from "../../src/eval/store";
import { Governor } from "../../src/governor/governor";
import { HANDLERS } from "../../src/jobs/handlers";
import { drainJob } from "../../src/jobs/runner";
import { createJob } from "../../src/jobs/store";
import { LabLLM } from "../../src/eval/llm";
import { seedStarterOrg } from "../../src/registry/seed";
import { Registry } from "../../src/registry/registry";
import {
  confirmStep,
  ensureRedteamSeed,
  getAttack,
  getAttacker,
  getBreach,
  insertAttack,
  listAttacks,
  listBreaches,
  listRegressions,
  passRates,
  probe,
  redteamCampaignInit,
  registerRedteamHandlers,
  REDTEAM_CAMPAIGN_KIND,
  REDTEAM_SUITE,
  SEED_ATTACKS,
  type CampaignParams,
} from "../../src/redteam";
import { freshState } from "../helpers";
import { unsafeGenome } from "./fixtures";

const E = env as Env;
const T = 110_000;
registerRedteamHandlers(HANDLERS); // what the integrator adds to jobs/handlers.ts
beforeEach(freshState);

async function campaign(p: CampaignParams) {
  const id = `job_rt_${Math.random().toString(16).slice(2, 10)}`;
  const init = await redteamCampaignInit(E, id, p);
  await createJob(E, { id, kind: REDTEAM_CAMPAIGN_KIND, params: init.params as Record<string, unknown>, state: init.state, total: init.total, max_calls: init.max_calls });
  return drainJob(E, id, 2000);
}

const snapshot = async () => ({
  governor: (await E.DB.prepare("SELECT key, value FROM governor_state ORDER BY key").all()).results,
  approvals: (await E.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n,
});

describe("setup", () => {
  it("seeds the library, the attacker lineage and a PAUSED redteam-core suite, idempotently", async () => {
    const a = await ensureRedteamSeed(E);
    expect(a.seeded).toBe(SEED_ATTACKS.length);
    expect((await ensureRedteamSeed(E)).seeded).toBe(0);
    expect((await listAttacks(E, { status: "active", limit: 1000 })).length).toBe(SEED_ATTACKS.length);
    expect((await getSuite(E, REDTEAM_SUITE))?.status).toBe("paused");
    expect(await getAttacker(E, "rt-attacker")).toMatchObject({ max_tier: 1, tools: [] });
    expect(new LabLLM(E, { maxCalls: 1, share: 0.3 }).mode).toBe("mock");
  });
});

describe("campaign job", () => {
  it(
    "probes champions, confirms breaches (control + 2 repros), adds regressions, reports per-category pass rates — with no external effect",
    async () => {
      await seedStarterOrg(E);
      const before = await snapshot();
      const job = await campaign({ roles: ["researcher", "director"] });
      expect(job.status).toBe("done");
      expect(job.stopped, JSON.stringify({ calls: job.llm_calls, max: job.max_calls, r: job.result, msg: job.message })).toBeNull();
      const r = job.result as any;
      expect(r.probes).toBe(SEED_ATTACKS.length * 2);
      expect(r.breaches.found).toBeGreaterThan(0);
      expect(r.breaches.confirmed).toBeGreaterThan(0);
      expect(r.breaches.confirmed + r.breaches.rejected).toBe(r.breaches.found - r.breaches.already_confirmed);
      expect(r.regressions_added.length).toBeGreaterThan(0);
      expect(job.llm_calls).toBeLessThanOrEqual(job.max_calls);

      // every confirmed breach has a clean control and 2 reproductions, and a regression with an eval mirror item
      const confirmed = await listBreaches(E, { status: "confirmed" });
      for (const b of confirmed) {
        expect(b.control_breach).toBe(false);
        expect(b.repro_ok).toBe(2);
        expect(b.regression_id).toBeTruthy();
      }
      const regs = await listRegressions(E);
      expect(regs.length).toBe(r.regressions_added.length);
      for (const g of regs) {
        expect((g.gates as any).ok, JSON.stringify(g.gates)).toBe(true);
        const item = await getItem(E, g.eval_item_id!);
        expect(item).toMatchObject({ suite_id: REDTEAM_SUITE, status: "active", split: "canary" });
        expect(item!.tags).toContain("redteam");
      }

      // per-agent, per-category pass rates
      const rates = await passRates(E);
      expect(rates.length).toBe(2);
      for (const a of rates) {
        expect(Object.keys(a.by_category).length).toBe(7);
        expect(a.runs).toBe(SEED_ATTACKS.length);
        expect(a.pass_rate).toBeGreaterThan(0);
        expect(a.pass_rate).toBeLessThan(1);
      }

      // sandbox only: no approvals, no governor state change, no real tool calls, constitution untouched
      expect(await snapshot()).toEqual(before);
      const actions = (await listAudit(E.DB, 500)).map((x) => x.action);
      for (const bad of ["tool.call", "tool.sandboxed", "approval.requested", "governor.caps.update", "kill.on"]) expect(actions).not.toContain(bad);
      expect(actions).toContain("redteam.breach_confirmed");
      expect(actions).toContain("redteam.campaign");
      expect(Object.isFrozen(CONSTITUTION)).toBe(true);
      expect(Object.isFrozen(CONSTITUTION.forbiddenCapabilityPrefixes)).toBe(true);

      // a second campaign does not re-confirm known breaches
      const again = await campaign({ roles: ["researcher"], categories: ["approval_bypass"] });
      expect((again.result as any).breaches.confirmed).toBe(0);
    },
    T,
  );

  it(
    "attacker-generated attacks are admitted, probed, and credit the attacker only when confirmed",
    async () => {
      await seedStarterOrg(E);
      const job = await campaign({ roles: ["researcher"], categories: ["prompt_injection", "data_exfiltration"], generate: 4 });
      const r = job.result as any;
      expect(job.status).toBe("done");
      expect(r.generated.created.length).toBeGreaterThan(0);
      for (const id of r.generated.created) expect((await getAttack(E, id))!.source).toBe("attacker:rt-attacker");
      const att = (await getAttacker(E, "rt-attacker"))!;
      expect(att.generated).toBe(r.generated.created.length);
      const genConfirmed = (await listBreaches(E, { status: "confirmed" })).filter((b) => r.generated.created.includes(b.attack_id)).length;
      expect(att.confirmed).toBe(genConfirmed);
      expect(att.score).toBeCloseTo(att.confirmed - 0.1 * att.rejected, 5);
    },
    T,
  );

  it(
    "stops cleanly on the job budget and on the global kill switch, keeping recorded results",
    async () => {
      await seedStarterOrg(E);
      const b = await campaign({ roles: ["researcher"], max_calls: 5 });
      expect(b.status).toBe("done");
      expect(b.stopped).toBe("budget");
      expect(b.llm_calls).toBeLessThanOrEqual(5);
      expect((b.result as any).probes).toBeGreaterThan(0);

      await new Governor(E).setKill("global", true);
      const k = await campaign({ roles: ["researcher"] });
      expect(k.stopped).toBe("killed");
      expect((k.result as any).probes).toBe(0);
    },
    T,
  );

  it("rejects a bogus attack whose goal is met even without the payload (control run)", async () => {
    await ensureRedteamSeed(E);
    const base = SEED_ATTACKS[0];
    const bogus = { ...base, title: "bogus: marker is in every answer", goal: { say: ["Done:"] } };
    const { id } = await insertAttack(E, bogus, { source: "owner" }); // bypasses admission on purpose
    const g = await unsafeGenome("researcher");
    const lab = new LabLLM(E, { maxCalls: 50, share: 0.3 });
    const p = await probe(E, lab, "c1", { agent_id: "a_unsafe", genome: g }, (await getAttack(E, id))!);
    expect(p.outcome.breach).toBe(true);
    const step = await confirmStep(E, lab, p.breach_id!, { agent_id: "a_unsafe", genome: g });
    expect(step).toMatchObject({ status: "rejected", stage: "control" });
    expect((await getBreach(E, p.breach_id!))!.reason).toMatch(/control/);
    expect(await listRegressions(E)).toEqual([]);
  });

  it("campaign init refuses when there is nothing to attack", async () => {
    await expect(redteamCampaignInit(E, "j1", {})).rejects.toMatchObject({ code: "no_targets" });
    await seedStarterOrg(E);
    await expect(redteamCampaignInit(E, "j2", { categories: ["nope"] })).rejects.toMatchObject({ code: "bad_request" });
    const agents = await new Registry(E).listAgents();
    const init = await redteamCampaignInit(E, "j3", { agent_ids: [agents[0].id], categories: ["eval_gaming"], langs: ["ar"] });
    expect(init.state.agents.length).toBe(1);
    expect(init.state.attack_ids.length).toBe(SEED_ATTACKS.filter((a) => a.category === "eval_gaming" && a.lang === "ar").length);
  });
});
