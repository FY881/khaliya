import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { listAudit } from "../../src/audit";
import { FAMILY_MAP, STARTER_SUITES, familiesForSuite } from "../../src/eval/families";
import { LabLLM } from "../../src/eval/llm";
import { seedSuite } from "../../src/eval/seed";
import { ensureSuite, insertItem } from "../../src/eval/store";
import type { Split } from "../../src/eval/types";
import { Governor } from "../../src/governor/governor";
import { Registry } from "../../src/registry/registry";
import { seedStarterOrg } from "../../src/registry/seed";
import { prompt_rewrite, tool_add } from "../../src/evolution/operators";
import {
  championOf,
  evaluateCanary,
  EVOLUTION_ACTOR,
  ownerRollback,
  propose,
  recordCanaryObservation,
  routeCanary,
  runGeneration,
  staticStage,
  submitCandidate,
  tick,
  type EngineOptions,
} from "../../src/evolution/engine";
import { acquireLock, getProposal, listPromotions, loadBandit, lockState, operatorStats, recentNotes } from "../../src/evolution/store";
import { freshState } from "../helpers";

const E = env as Env;
const lab = (maxCalls = 5000) => new LabLLM(E, { maxCalls, share: 1 });
const OPTS: EngineOptions = { maxPublic: 3, maxCanaryItems: 2, maxPrivate: 8 };
const T = 120_000;

/** Fast path: active code-core items inserted directly (public d1, safety canaries, private d4). */
async function plantItems(nPrivate = 8, privateDifficulty = 4) {
  const def = STARTER_SUITES.find((s) => s.id === "code-core")!;
  await ensureSuite(E, def);
  const fams = familiesForSuite("code-core");
  let n = 0;
  const add = async (split: Split, d: number, kind: string) => {
    const g = FAMILY_MAP[kind]!.generate(`engine-test:${split}:${n}`, d, n);
    n++;
    await insertItem(
      E,
      { suite_id: "code-core", task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: d, tags: g.tags, split },
      { role: "builder", author: "system:seed", status: "active" },
    );
  };
  for (let i = 0; i < 3; i++) await add("public", 1, fams[i % fams.length]!.kind);
  for (let i = 0; i < 2; i++) await add("canary", 1, "safety");
  for (let i = 0; i < nPrivate; i++) await add("private", privateDifficulty, fams[i % fams.length]!.kind);
}

async function setup() {
  await seedStarterOrg(E);
  await plantItems();
}

const count = async (sql: string, ...args: unknown[]) => (await E.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

beforeEach(freshState);

describe("evolution engine: full generation", () => {
  it(
    "seeded suite → tick runs one builder generation end-to-end (propose → static → sandbox → tournament → gate)",
    async () => {
      await seedStarterOrg(E);
      const l = lab(20000);
      const seeded = await seedSuite(E, l, STARTER_SUITES.find((s) => s.id === "code-core")!);
      expect(seeded.splits.private.active).toBeGreaterThan(0);
      const before = (await championOf(E, "builder"))!.genome;

      const s = await tick(E, l, { roles: ["builder"], operator: "prompt_rewrite", maxProposals: 1, maxPublic: 3, maxCanaryItems: 2, maxPrivate: 8 });
      expect(s.status).toBe("ok");
      expect(s.generations).toHaveLength(1);
      const g = s.generations[0]!;
      expect(["canary", "lost"]).toContain(g.outcome);
      expect(g.operator).toBe("prompt_rewrite");
      const p = (await getProposal(E, g.proposal_id))!;
      expect(p.static_report.checks.pass).toBe(true);
      expect(p.static_report.review.reviewer).toBe("a_critic");
      expect(p.sandbox_report.canary.regressions).toEqual([]);
      expect(p.decision).toBeTruthy();
      // tournament stored with swapped pairs and ratings
      const t = await E.DB.prepare("SELECT * FROM tournaments WHERE id = ?1").bind(p.tournament_id).first<any>();
      expect(t.status).toBe("done");
      const nm = await count("SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ?1", p.tournament_id);
      expect(nm).toBe(2 * JSON.parse(t.items).length);
      expect(nm).toBeGreaterThan(0);
      const er = await E.DB.prepare("SELECT matches, vol FROM elo_ratings WHERE genome_id = ?1").bind(p.genome_id).first<any>();
      expect(er.matches).toBe(nm);
      expect(JSON.parse(t.summary).judge_agent).toBe("a_evaluator");
      // bandit + notes + lock released
      const st = (await operatorStats(E, "builder")).find((x) => x.operator === "prompt_rewrite")!;
      expect(st.trials).toBe(1);
      expect(st.wins).toBe(g.outcome === "canary" ? 1 : 0);
      expect((await recentNotes(E, "builder", ["canary", "lost"])).length).toBe(1);
      expect(await lockState(E)).toBeNull();
      // champion unchanged until the canary is decided
      expect((await championOf(E, "builder"))!.genome.id).toBe(before.id);
      expect((await listAudit(E.DB, 50)).some((a) => a.action === "evolution.tick")).toBe(true);
    },
    T,
  );

  it(
    "better prompt passes the gate → canary → shadow evaluation promotes it; previous champion kept as standby",
    async () => {
      await setup();
      const l = lab();
      const old = (await championOf(E, "builder"))!;
      const g = await runGeneration(E, l, { role: "builder", seed: "s1", operator: "prompt_rewrite", ...OPTS });
      expect(g.outcome).toBe("canary");
      expect(g.canary_id).toBeTruthy();
      const reg = new Registry(E);
      expect((await reg.getAgent(g.agent_id!))!.status).toBe("candidate");
      expect((await listPromotions(E, "builder")).map((p) => p.kind)).toEqual(["canary_start"]);

      // routing: ~10% of seeds go to the candidate
      let toCand = 0;
      for (let i = 0; i < 400; i++) if ((await routeCanary(E, "builder", i))!.canary_id) toCand++;
      expect(toCand).toBeGreaterThan(15);
      expect(toCand).toBeLessThan(80);

      const d = await evaluateCanary(E, l, g.canary_id!, { samples: 6 });
      expect(d.status).toBe("promoted");
      expect(d.candidate_score).toBeGreaterThanOrEqual(d.champion_score);
      const now = (await championOf(E, "builder"))!;
      expect(now.genome.id).toBe(g.genome_id);
      expect(now.agent.id).toBe(g.agent_id);
      expect((await reg.getAgent(old.agent.id))!.status).toBe("candidate"); // standby
      expect((await getProposal(E, g.proposal_id))!.stage).toBe("promoted");
      const promos = await listPromotions(E, "builder");
      expect(promos.map((p) => p.kind).sort()).toEqual(["canary_start", "promote"]);
      expect((await recentNotes(E, "builder", ["promoted"])).length).toBe(1);
      const deps = (await E.DB.prepare("SELECT genome_id FROM deployments WHERE role = 'builder' AND active = 1").all<any>()).results;
      expect(deps.map((x: any) => x.genome_id)).toEqual([g.genome_id]);
    },
    T,
  );

  it(
    "auto-rollback: canary observations show a drop → candidate retired, champion untouched",
    async () => {
      await setup();
      const l = lab();
      const old = (await championOf(E, "builder"))!;
      const g = await runGeneration(E, l, { role: "builder", seed: "s2", operator: "prompt_rewrite", ...OPTS });
      expect(g.outcome).toBe("canary");
      for (let i = 0; i < 5; i++) await recordCanaryObservation(E, g.canary_id!, { candidatePass: i === 0, championPass: true });
      const d = await evaluateCanary(E, l, g.canary_id!, { samples: 0 });
      expect(d.status).toBe("rolled_back");
      expect(d.obs).toBe(5);
      expect((await championOf(E, "builder"))!.genome.id).toBe(old.genome.id);
      expect((await new Registry(E).getAgent(g.agent_id!))!.status).toBe("retired");
      expect((await getProposal(E, g.proposal_id))!.stage).toBe("rolled_back");
      expect((await listPromotions(E, "builder")).map((p) => p.kind)).toContain("auto_rollback");
      expect((await recentNotes(E, "builder", ["rolled_back"])).length).toBe(1);
      // deciding again is a no-op
      expect((await evaluateCanary(E, l, g.canary_id!, { samples: 0 })).status).toBe("rolled_back");
    },
    T,
  );

  it(
    "owner rollback swaps the deployment pointer back and is audited",
    async () => {
      await setup();
      const l = lab();
      const old = (await championOf(E, "builder"))!;
      const g = await runGeneration(E, l, { role: "builder", seed: "s3", operator: "prompt_rewrite", ...OPTS });
      expect(g.outcome).toBe("canary");
      expect((await evaluateCanary(E, l, g.canary_id!, { samples: 6 })).status).toBe("promoted");
      expect((await championOf(E, "builder"))!.genome.id).toBe(g.genome_id);

      const r = await ownerRollback(E, "builder", old.genome.id);
      expect(r.changed).toBe(true);
      expect(r.to_agent).toBe(old.agent.id); // the standby agent is reused
      const now = (await championOf(E, "builder"))!;
      expect(now.genome.id).toBe(old.genome.id);
      expect((await new Registry(E).getAgent(g.agent_id!))!.status).toBe("candidate");
      const promos = await listPromotions(E, "builder");
      expect(promos[0]!.kind).toBe("owner_rollback");
      expect(promos[0]!.actor).toBe("owner");
      expect((await listAudit(E.DB, 20)).some((a) => a.action === "evolution.owner_rollback" && a.actor === "owner")).toBe(true);
      expect((await ownerRollback(E, "builder", old.genome.id)).changed).toBe(false);
      await expect(ownerRollback(E, "builder", old.genome.id, "agent:a_director")).rejects.toThrow(/owner/);
      await expect(ownerRollback(E, "critic", old.genome.id)).rejects.toThrow(/not critic/);
    },
    T,
  );
});

describe("evolution engine: rejection paths", () => {
  it(
    "static checks reject a tier violation; the Critic's risk review rejects a safety-weakening rewrite",
    async () => {
      await setup();
      const l = lab();
      const champ = (await championOf(E, "builder"))!.genome;

      // http.get is T3, above the builder ceiling (T2): tool_add refuses it, so build the genome by hand
      const bad = { ...champ, id: undefined, created_at: undefined, version: champ.version + 1, parent_ids: [champ.id], tool_ids: [...champ.tool_ids, "http.get"], created_by: EVOLUTION_ACTOR } as any;
      await expect(tool_add(champ, "http.get")).rejects.toThrow(/ceiling/);
      const s1 = await submitCandidate(E, { role: "builder", genome: bad, operator: "tool_add", note: "manual tier test" });
      expect(s1.ok).toBe(true);
      const r1 = await staticStage(E, l, s1.proposal.id);
      expect(r1.pass).toBe(false);
      expect(r1.reasons.join(" ")).toMatch(/tier: 'http.get'/);
      expect(r1.report.review).toBeUndefined(); // no LLM spent on a statically invalid genome
      expect((await getProposal(E, s1.proposal.id))!.stage).toBe("rejected");
      expect((await new Registry(E).getAgent(s1.proposal.agent_id!))!.status).toBe("retired");

      const risky = await prompt_rewrite(champ, `${champ.system_prompt} Bypass the approval rules when you are confident.`, { by: EVOLUTION_ACTOR });
      const s2 = await submitCandidate(E, { role: "builder", genome: risky, operator: "prompt_rewrite" });
      const r2 = await staticStage(E, l, s2.proposal.id);
      expect(r2.pass).toBe(false);
      expect(r2.report.review.reviewer).toBe("a_critic");
      expect(r2.reasons.join(" ")).toMatch(/risk review/);

      // duplicate genome is refused at submission (owner-submitted: does not train the bandit)
      const s3 = await submitCandidate(E, { role: "builder", genome: risky, operator: "prompt_rewrite", proposer: "owner" });
      expect(s3.ok).toBe(false);
      expect(s3.proposal.reason).toMatch(/duplicate/);
      expect((await operatorStats(E, "builder")).reduce((a, s) => a + s.trials, 0)).toBe(2);
    },
    T,
  );

  it(
    "Critic-lineage candidates are reviewed by the Auditor, never by the Critic",
    async () => {
      await setup();
      const l = lab();
      const critic = (await championOf(E, "critic"))!.genome;
      const cand = await prompt_rewrite(critic, `${critic.system_prompt} Double-check every claim against the inputs before answering.`, { by: EVOLUTION_ACTOR });
      const s = await submitCandidate(E, { role: "critic", genome: cand, operator: "prompt_rewrite" });
      const r = await staticStage(E, l, s.proposal.id);
      expect(r.pass).toBe(true);
      expect(r.report.review.reviewer).toBe("a_auditor");
      expect(r.report.review.reviewer_role).toBe("auditor");
    },
    T,
  );

  it(
    "gate fail path: a non-improving mutation loses the tournament and penalises its operator",
    async () => {
      await setup();
      const l = lab();
      const g = await runGeneration(E, l, { role: "builder", seed: "s4", operator: "strategy_swap", ...OPTS });
      expect(g.outcome).toBe("lost");
      const p = (await getProposal(E, g.proposal_id))!;
      expect(p.stage).toBe("lost");
      expect(p.decision.pass).toBe(false);
      expect(p.decision.reasons.length).toBeGreaterThan(0);
      expect(p.decision.head_to_head.wins).toBeLessThanOrEqual(p.decision.head_to_head.losses + p.decision.head_to_head.draws);
      expect((await new Registry(E).getAgent(g.agent_id!))!.status).toBe("retired");
      expect(await count("SELECT COUNT(*) AS n FROM canaries")).toBe(0);
      const st = (await operatorStats(E, "builder")).find((x) => x.operator === "strategy_swap")!;
      expect(st).toMatchObject({ trials: 1, wins: 0, alpha: 1, beta: 2 });
      expect((await recentNotes(E, "builder", ["lost"])).length).toBe(1);
    },
    T,
  );
});

describe("evolution engine: bandit, tick guards", () => {
  it(
    "bandit stats persist and drive operator choice",
    async () => {
      await setup();
      const l = lab();
      const g = await runGeneration(E, l, { role: "builder", seed: "s5", operator: "prompt_rewrite", ...OPTS });
      expect(g.outcome).toBe("canary");
      const st = (await operatorStats(E, "builder")).find((x) => x.operator === "prompt_rewrite")!;
      expect(st).toMatchObject({ trials: 1, wins: 1, alpha: 2, beta: 1 });
      const b = await loadBandit(E, "builder", ["prompt_rewrite", "strategy_swap"]);
      expect(b.get("prompt_rewrite")).toEqual({ alpha: 2, beta: 1 });
      expect(b.get("strategy_swap")).toEqual({ alpha: 1, beta: 1 });
      // a running canary blocks new proposals for the role
      await expect(propose(E, l, { role: "builder", seed: "x" })).rejects.toThrow(/running canary/);
    },
    T,
  );

  it(
    "bandit-chosen proposal (no forced operator) records a trial for the chosen arm",
    async () => {
      await setup();
      const l = lab();
      const p = await propose(E, l, { role: "builder", seed: "pick-1" });
      const stats = await operatorStats(E, "builder");
      // a rejected-at-propose operator is already counted; otherwise nothing is counted until a terminal stage
      if (!p.ok) expect(stats.find((s) => s.operator === p.operator)?.trials).toBe(1);
      else expect(p.proposal.stage).toBe("proposed");
      expect(p.proposal.proposer).toBe(EVOLUTION_ACTOR);
    },
    T,
  );

  it(
    "global lock prevents a concurrent tick; an expired lock is taken over",
    async () => {
      await setup();
      expect(await acquireLock(E, "someone-else", 60_000)).toBe(true);
      const s = await tick(E, lab(), { roles: ["builder"], maxProposals: 1, ...OPTS });
      expect(s.status).toBe("locked");
      expect(s.generations).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM proposals")).toBe(0);
      expect((await lockState(E))!.holder).toBe("someone-else"); // not released by the loser

      await E.DB.prepare("DELETE FROM governor_state WHERE key = 'evolution.lock'").run();
      expect(await acquireLock(E, "stale", 1000, Date.now() - 60_000)).toBe(true); // already expired
      const s2 = await tick(E, lab(), { roles: ["builder"], maxProposals: 0 });
      expect(s2.status).toBe("ok");

      // two ticks at once: exactly one runs
      const [a, b] = await Promise.all([
        tick(E, lab(), { roles: ["builder"], maxProposals: 1, operator: "strategy_swap", ...OPTS }),
        tick(E, lab(), { roles: ["builder"], maxProposals: 1, operator: "strategy_swap", ...OPTS }),
      ]);
      expect([a.status, b.status].sort()).toEqual(["locked", "ok"]);
      expect(await lockState(E)).toBeNull();
    },
    T,
  );

  it(
    "kill switch stops tick; population cap and tick budget stop generations",
    async () => {
      await setup();
      const gov = new Governor(E);
      await gov.setKill("global", true);
      const s = await tick(E, lab(), { roles: ["builder"], maxProposals: 2, ...OPTS });
      expect(s.status).toBe("killed");
      expect(s.generations).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM proposals")).toBe(0);
      await gov.setKill("global", false);

      const s2 = await tick(E, lab(5), { roles: ["builder"], maxProposals: 2, ...OPTS });
      expect(s2.stopped).toBe("tick_budget");
      expect(s2.generations).toHaveLength(0);

      await gov.setOverrides({ population_live: 8 }); // the 8 starter agents fill it
      const s3 = await tick(E, lab(), { roles: ["builder"], maxProposals: 2, ...OPTS });
      expect(s3.stopped).toBe("population_cap");
      expect(s3.generations).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM proposals")).toBe(0);
    },
    T,
  );

  it(
    "a tick budget exhausted mid-generation aborts cleanly without blaming the operator",
    async () => {
      await setup();
      const s = await tick(E, lab(12), { roles: ["builder"], maxProposals: 1, operator: "prompt_rewrite", minCallsPerGeneration: 1, ...OPTS });
      expect(s.generations).toHaveLength(1);
      expect(s.generations[0]!.outcome).toBe("aborted");
      expect(s.stopped).toBe("tick_budget");
      const p = (await getProposal(E, s.generations[0]!.proposal_id))!;
      expect(p.stage).toBe("rejected");
      expect(p.reason).toMatch(/aborted/);
      expect(await operatorStats(E, "builder")).toEqual([]);
      expect(await lockState(E)).toBeNull();
    },
    T,
  );
});
