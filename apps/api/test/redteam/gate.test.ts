/** redteamGate(): the evolution engine's promotion hook — no regression on redteam-core. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { LabBudgetError, LabLLM } from "../../src/eval/llm";
import { Governor } from "../../src/governor/governor";
import { HANDLERS } from "../../src/jobs/handlers";
import { drainJob } from "../../src/jobs/runner";
import { createJob } from "../../src/jobs/store";
import { championGenome } from "../../src/eval/validate";
import { seedStarterOrg } from "../../src/registry/seed";
import { listRegressions, redteamCampaignInit, redteamGate, registerRedteamHandlers, REDTEAM_CAMPAIGN_KIND } from "../../src/redteam";
import { freshState } from "../helpers";
import { hardenedGenome, unsafeGenome } from "./fixtures";

const E = env as Env;
const T = 110_000;
registerRedteamHandlers(HANDLERS);
beforeEach(freshState);
const lab = (n = 500) => new LabLLM(E, { maxCalls: n, share: 0.3 });

async function buildSuite() {
  await seedStarterOrg(E);
  const id = "job_rt_gate";
  const init = await redteamCampaignInit(E, id, { roles: ["researcher"] });
  await createJob(E, { id, kind: REDTEAM_CAMPAIGN_KIND, params: {}, state: init.state, total: init.total, max_calls: init.max_calls });
  const j = await drainJob(E, id, 2000);
  expect(j.status).toBe("done");
  const regs = await listRegressions(E);
  expect(regs.length).toBeGreaterThan(0);
  return regs;
}

describe("redteamGate", () => {
  it("passes trivially while redteam-core is empty", async () => {
    const r = await redteamGate(await unsafeGenome(), { env: E, lab: lab(), champion: null });
    expect(r).toMatchObject({ pass: true, total: 0, suite: "redteam-core", llm_calls: 0 });
  });

  it(
    "fails a candidate that breaches tests the champion passes; passes a hardened one and reports what it fixes",
    async () => {
      const regs = await buildSuite();
      const hard = await hardenedGenome("researcher");
      const weak = await unsafeGenome("researcher");

      const bad = await redteamGate(weak, { env: E, lab: lab(), champion: hard });
      expect(bad.pass).toBe(false);
      expect(bad.regressions.length).toBe(regs.length);
      expect(bad.candidate.pass_rate).toBe(0);
      expect(bad.champion!.pass_rate).toBe(1);
      expect(bad.reasons.join()).toMatch(/regression/);

      const champ = (await championGenome(E, "researcher"))!;
      const good = await redteamGate({ genome: hard, champion: champ }, { env: E, lab: lab() });
      expect(good.pass).toBe(true);
      expect(good.fixed.length).toBe(regs.length); // the champion breached every regression it produced
      expect(good.candidate.pass_rate).toBe(1);

      // the champion against itself: no regression, but strict mode demands 100%
      expect((await redteamGate(champ, { env: E, lab: lab() })).pass).toBe(true);
      expect((await redteamGate(champ, { env: E, lab: lab(), strict: true })).pass).toBe(false);

      // results are cached per genome: a repeat gate costs no LLM calls
      const again = await redteamGate(weak, { env: E, lab: lab(), champion: hard });
      expect(again.llm_calls).toBe(0);
      expect(again.pass).toBe(false);
    },
    T,
  );

  it(
    "respects maxTests, the kill switch and the call budget",
    async () => {
      const regs = await buildSuite();
      const fresh = await hardenedGenome("director");
      const r = await redteamGate(fresh, { env: E, lab: lab(), champion: null, maxTests: 1 });
      expect(r.total).toBe(1);
      expect(r.sampled).toBe(regs.length > 1);
      await expect(redteamGate(await unsafeGenome("director"), { env: E, lab: lab(0), champion: null })).rejects.toBeInstanceOf(LabBudgetError);
      await new Governor(E).setKill("global", true);
      await expect(redteamGate(await unsafeGenome("builder"), { env: E, lab: lab(), champion: null })).rejects.toMatchObject({ scope: "killed" });
    },
    T,
  );
});
