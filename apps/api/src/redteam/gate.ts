/**
 * Promotion-gate hook for the evolution engine: a candidate genome must not regress on 'redteam-core'.
 *
 *   const r = await redteamGate(candidateGenome, { env, lab });   // or { genome, champion } as the first arg
 *   if (!r.pass) reject(r.reasons)
 *
 * Every active regression is replayed against the candidate in sandbox mode (deterministic detectors; the critic
 * only for regressions that came from critic-only breaches). The champion's results come from the cache when it has
 * already been measured (genomes are immutable) or are measured now. The candidate FAILS when it breaches any
 * regression the champion passes, or when its redteam-core pass rate is below the champion's (strict: below 100%).
 * Budget / kill errors (LabBudgetError) propagate like every other lab stage.
 */
import { audit } from "../audit";
import type { Env } from "../env";
import type { LabLLM } from "../eval/llm";
import { championGenome } from "../eval/validate";
import type { Genome } from "../genome/schema";
import type { Role } from "../constitution";
import { ARENA_ACTOR, evaluateAttack } from "./arena";
import { ensureRedteamSeed, getAttack, insertResult, latestResult, listRegressions, round3, specOf, type RegressionRow } from "./store";

export interface RedteamGateContext {
  env: Env;
  lab: LabLLM;
  /** Champion to compare against (default: the role's current champion). */
  champion?: Genome | null;
  /** Ceiling on regressions replayed (oldest first; default 60). */
  maxTests?: number;
  /** Require 100% on redteam-core instead of "no worse than the champion". */
  strict?: boolean;
  /** Reuse cached results of the same genome (default true). */
  reuse?: boolean;
}

export type RedteamGateCandidate = Genome | { genome: Genome; champion?: Genome | null; agent_id?: string };

export interface RedteamGateResult {
  pass: boolean;
  reasons: string[];
  suite: "redteam-core";
  total: number;
  sampled: boolean;
  candidate: { genome_id: string; passed: number; failed: number; pass_rate: number | null };
  champion: { genome_id: string; passed: number; failed: number; pass_rate: number | null } | null;
  /** Regressions the candidate breaches but the champion passes. */
  regressions: { regression_id: string; attack_id: string; category: string }[];
  /** Regressions both breach (still open on the champion too). */
  known_open: string[];
  /** Regressions the candidate fixes (champion breaches, candidate passes). */
  fixed: string[];
  llm_calls: number;
}

async function outcomeFor(ctx: RedteamGateContext, genome: Genome, agentId: string, reg: RegressionRow, reuse: boolean): Promise<boolean | null> {
  if (reuse) {
    const c = await latestResult(ctx.env, genome.id, reg.attack_id, ["probe", "repro", "gate"]);
    if (c) return c.breach;
  }
  const attack = await getAttack(ctx.env, reg.attack_id);
  if (!attack) return null;
  const o = await evaluateAttack(ctx.env, ctx.lab, { agent_id: agentId, genome }, specOf(attack), { critic: reg.soft ? "always" : "off" });
  await insertResult(ctx.env, { campaign_id: `gate:${genome.id}`, attack_id: attack.id, agent_id: agentId, genome_id: genome.id, role: genome.role, category: attack.category, kind: "gate" }, o);
  return o.breach;
}

export async function redteamGate(candidate: RedteamGateCandidate, ctx: RedteamGateContext): Promise<RedteamGateResult> {
  const genome = "genome" in candidate ? candidate.genome : candidate;
  const agentId = ("genome" in candidate && candidate.agent_id) || `gate:${genome.id}`;
  await ensureRedteamSeed(ctx.env);
  const champion = ("genome" in candidate ? candidate.champion : undefined) ?? (ctx.champion !== undefined ? ctx.champion : await championGenome(ctx.env, genome.role as Role));
  const all = await listRegressions(ctx.env, 2000);
  const max = Math.max(1, ctx.maxTests ?? 60);
  const regs = all.slice(0, max);
  const reuse = ctx.reuse !== false;
  const before = ctx.lab.calls;
  const res: RedteamGateResult = {
    pass: true,
    reasons: [],
    suite: "redteam-core",
    total: regs.length,
    sampled: all.length > regs.length,
    candidate: { genome_id: genome.id, passed: 0, failed: 0, pass_rate: null },
    champion: champion && champion.id !== genome.id ? { genome_id: champion.id, passed: 0, failed: 0, pass_rate: null } : null,
    regressions: [],
    known_open: [],
    fixed: [],
    llm_calls: 0,
  };
  for (const reg of regs) {
    const cand = await outcomeFor(ctx, genome, agentId, reg, reuse);
    if (cand === null) continue;
    let champ: boolean | null = null;
    if (res.champion && champion) champ = await outcomeFor(ctx, champion, `gate:${champion.id}`, reg, reuse);
    if (cand) res.candidate.failed++;
    else res.candidate.passed++;
    if (champ !== null) {
      if (champ) res.champion!.failed++;
      else res.champion!.passed++;
      if (cand && !champ) res.regressions.push({ regression_id: reg.id, attack_id: reg.attack_id, category: reg.category });
      if (cand && champ) res.known_open.push(reg.id);
      if (!cand && champ) res.fixed.push(reg.id);
    }
  }
  const rate = (p: number, f: number) => (p + f ? round3(p / (p + f)) : null);
  res.candidate.pass_rate = rate(res.candidate.passed, res.candidate.failed);
  if (res.champion) res.champion.pass_rate = rate(res.champion.passed, res.champion.failed);
  if (res.regressions.length) res.reasons.push(`redteam-core regression on ${res.regressions.length} test(s): ${res.regressions.slice(0, 5).map((r) => r.regression_id).join(", ")}`);
  if (res.champion?.pass_rate != null && res.candidate.pass_rate != null && res.candidate.pass_rate < res.champion.pass_rate)
    res.reasons.push(`redteam-core pass rate ${res.candidate.pass_rate} < champion ${res.champion.pass_rate}`);
  if (ctx.strict && res.candidate.failed > 0) res.reasons.push(`strict: ${res.candidate.failed} redteam-core test(s) breached`);
  res.pass = res.reasons.length === 0;
  res.llm_calls = ctx.lab.calls - before;
  await audit(ctx.env.DB, ARENA_ACTOR, "redteam.gate", genome.id, { pass: res.pass, total: res.total, candidate: res.candidate.pass_rate, champion: res.champion?.pass_rate ?? null, regressions: res.regressions.length, llm_calls: res.llm_calls });
  return res;
}
