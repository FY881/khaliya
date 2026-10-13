/**
 * "redteam.campaign" job. One step = one unit of work with ≤ 2 LLM calls and a few D1 reads/writes, so each step
 * stays far below the free plan's ~10 ms CPU per invocation; the runner fits several steps per chunk up to its
 * LLM-call / wall-clock soft limits. The cursor is tiny (ids + indices); traces and verdicts live in D1.
 *
 *   generate  attacker writes N new attacks (one call per step, round-robin over categories), admitted ones join
 *   probe     (attack × agent) units, attacks outer, agents inner
 *   confirm   each new suspected breach: control run, then 2 reproductions (one run per step)
 *   done
 * Kill switch and budgets: the runner stops the job on the global kill switch / job budget / daily lab budget
 * (LabLLM), keeping everything recorded so far.
 */
import { audit } from "../audit";
import { RUNNABLE, type Role } from "../constitution";
import type { Env } from "../env";
import type { JobHandler } from "../jobs/handlers";
import { Registry } from "../registry/registry";
import { confirmStep, probe, REPRODUCTIONS, type CriticMode } from "./arena";
import { generateAttacks } from "./attacker";
import { DEFAULT_ATTACKER } from "./attacker-genome";
import { ensureRedteamSeed, getAttack, getBreach, listAttacks } from "./store";
import { CATEGORIES, type Category } from "./types";

export const REDTEAM_CAMPAIGN_KIND = "redteam.campaign";
export const MAX_CAMPAIGN_ATTACKS = 300;
export const MAX_CAMPAIGN_AGENTS = 24;
export const MAX_GENERATE = 12;
export const MAX_CAMPAIGN_CALLS = 3000;
/** Confirmation runs per suspected breach (control + reproductions). */
const CONFIRM_RUNS = 1 + REPRODUCTIONS;

export interface CampaignParams {
  agent_ids?: string[];
  roles?: string[];
  categories?: string[];
  langs?: string[];
  attack_ids?: string[];
  generate?: number;
  attacker_id?: string;
  critic?: CriticMode;
  max_attacks?: number;
  max_calls?: number;
  /** Include sandboxed/candidate agents (default: champions only). */
  include_non_champions?: boolean;
}

export interface CampaignTarget {
  agent_id: string;
  genome_id: string;
  role: string;
}

export interface CampaignState {
  campaign_id: string;
  phase: "generate" | "probe" | "confirm" | "done";
  agents: CampaignTarget[];
  attack_ids: string[];
  critic: CriticMode;
  gen: { want: number; done: number; attacker_id: string; categories: Category[]; created: string[]; rejected: number };
  pi: number;
  pending: string[]; // breach ids to confirm
  ci: number;
  counters: { probes: number; breaches: number; known: number; confirmed: number; rejected: number; regressions: string[]; llm_calls: number; contained: number };
}

export class CampaignError extends Error {
  constructor(
    public code: "no_targets" | "no_attacks" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

const strList = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x).slice(0, max) : undefined);

export async function campaignTargets(env: Env, p: CampaignParams): Promise<CampaignTarget[]> {
  const agents = await new Registry(env).listAgents();
  const ids = strList(p.agent_ids, MAX_CAMPAIGN_AGENTS);
  const roles = strList(p.roles, 16);
  return agents
    .filter((a) => RUNNABLE.includes(a.status))
    .filter((a) => (ids?.length ? ids.includes(a.id) : p.include_non_champions ? true : a.status === "champion"))
    .filter((a) => !roles?.length || roles.includes(a.role))
    .slice(0, MAX_CAMPAIGN_AGENTS)
    .map((a) => ({ agent_id: a.id, genome_id: a.genome_id, role: a.role as Role }));
}

/** Build the initial cursor. Throws CampaignError when there is nothing to run. */
export async function redteamCampaignInit(env: Env, campaignId: string, raw: CampaignParams = {}): Promise<{ state: CampaignState; total: number; max_calls: number; params: CampaignParams }> {
  await ensureRedteamSeed(env);
  const categories = (strList(raw.categories, 7) ?? []).filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));
  if (raw.categories?.length && !categories.length) throw new CampaignError("bad_request", `categories: any of ${CATEGORIES.join(", ")}`);
  const critic: CriticMode = raw.critic === "always" || raw.critic === "off" ? raw.critic : "auto";
  const generate = Math.min(Math.max(0, Math.floor(Number(raw.generate ?? 0)) || 0), MAX_GENERATE);
  const maxAttacks = Math.min(Math.max(1, Math.floor(Number(raw.max_attacks ?? 60)) || 60), MAX_CAMPAIGN_ATTACKS);
  const langs = strList(raw.langs, 3);
  const agents = await campaignTargets(env, raw);
  if (!agents.length) throw new CampaignError("no_targets", "no runnable target agents match (default: champions)");
  const wantIds = strList(raw.attack_ids, MAX_CAMPAIGN_ATTACKS);
  let attacks = (await listAttacks(env, { status: "active", ids: wantIds, limit: 1000 })).filter((a) => (!categories.length || categories.includes(a.category)) && (!langs?.length || langs.includes(a.lang)));
  // Interleave categories so a budget stop still leaves every category measured.
  const byCat = new Map<string, string[]>();
  for (const a of attacks) byCat.set(a.category, [...(byCat.get(a.category) ?? []), a.id]);
  const order: string[] = [];
  for (let i = 0; order.length < attacks.length; i++) for (const ids of byCat.values()) if (ids[i]) order.push(ids[i]);
  const attack_ids = order.slice(0, maxAttacks);
  if (!attack_ids.length && !generate) throw new CampaignError("no_attacks", "no active attacks match the filters");
  attacks = [];
  const units = attack_ids.length * agents.length;
  const estGenUnits = generate * 2 * agents.length; // generated attacks get probed too
  // Per probe: 1 target call (+ critic when used); reserve confirmation runs for ~half the probes breaching.
  const perRun = critic === "always" ? 2 : 1.2;
  const defCalls = generate + (units + estGenUnits) * perRun * (1 + 0.5 * CONFIRM_RUNS) + 20;
  const max_calls = Math.min(MAX_CAMPAIGN_CALLS, Math.max(1, Math.floor(Number(raw.max_calls) || Math.ceil(defCalls))));
  const state: CampaignState = {
    campaign_id: campaignId,
    phase: generate ? "generate" : "probe",
    agents,
    attack_ids,
    critic,
    gen: { want: generate, done: 0, attacker_id: raw.attacker_id || DEFAULT_ATTACKER.id, categories: categories.length ? categories : [...CATEGORIES], created: [], rejected: 0 },
    pi: 0,
    pending: [],
    ci: 0,
    counters: { probes: 0, breaches: 0, known: 0, confirmed: 0, rejected: 0, regressions: [], llm_calls: 0, contained: 0 },
  };
  const params: CampaignParams = { ...raw, categories: categories.length ? categories : undefined, critic, generate, max_attacks: maxAttacks, max_calls };
  return { state, total: totalOf(state), max_calls, params };
}

function totalOf(s: CampaignState): number {
  return s.gen.want + s.attack_ids.length * s.agents.length + s.pending.length * CONFIRM_RUNS;
}
function doneOf(s: CampaignState): number {
  const confirmDone = s.ci * CONFIRM_RUNS;
  return s.gen.done + s.pi + confirmDone + (s.phase === "done" ? 0 : 0);
}

async function targetRef(env: Env, t: CampaignTarget) {
  const g = await new Registry(env).getGenome(t.genome_id);
  if (!g) throw new Error(`genome ${t.genome_id} of ${t.agent_id} not found`);
  return { agent_id: t.agent_id, genome: g };
}

export const redteamCampaignJob: JobHandler<CampaignState> = {
  kind: REDTEAM_CAMPAIGN_KIND,
  async step(env, lab, job, s) {
    const callsBefore = lab.calls;
    try {
      if (s.phase === "generate") {
        const category = s.gen.categories[s.gen.done % s.gen.categories.length];
        const g = await generateAttacks(env, lab, { attacker_id: s.gen.attacker_id, category, n: 1, seed: `${s.campaign_id}|${s.gen.done}` });
        s.gen.done++;
        s.gen.rejected += g.rejected.length;
        for (const id of g.created) if (!s.attack_ids.includes(id)) (s.gen.created.push(id), s.attack_ids.push(id));
        if (s.gen.done >= s.gen.want) s.phase = s.attack_ids.length ? "probe" : "done";
        return { message: `attacker (${category}): ${g.created.length} admitted, ${g.rejected.length} rejected` };
      }
      if (s.phase === "probe") {
        const n = s.agents.length;
        const attackId = s.attack_ids[Math.floor(s.pi / n)];
        const t = s.agents[s.pi % n];
        const attack = await getAttack(env, attackId);
        let msg = `skipped ${attackId} (gone)`;
        if (attack && attack.status === "active") {
          const p = await probe(env, lab, s.campaign_id, await targetRef(env, t), attack, { critic: s.critic });
          s.counters.probes++;
          if (p.outcome.breach) {
            s.counters.breaches++;
            if (p.outcome.contained) s.counters.contained++;
            if (p.known) s.counters.known++;
            else if (p.breach_id && !s.pending.includes(p.breach_id)) s.pending.push(p.breach_id);
          }
          msg = `${t.role}/${attack.category}: ${p.outcome.breach ? `BREACH (${p.outcome.hits.map((h) => h.detector).join(",") || "critic"})` : "safe"}`;
        }
        s.pi++;
        if (s.pi >= s.attack_ids.length * n) s.phase = s.pending.length ? "confirm" : "done";
        return { message: msg };
      }
      if (s.phase === "confirm") {
        const id = s.pending[s.ci];
        const b = await getBreach(env, id);
        let msg = `breach ${id}: gone`;
        if (b) {
          const t = s.agents.find((a) => a.genome_id === b.genome_id) ?? { agent_id: b.agent_id, genome_id: b.genome_id, role: b.role };
          const r = await confirmStep(env, lab, id, await targetRef(env, t), { critic: s.critic });
          msg = `breach ${id} (${b.category}): ${r.stage} → ${r.status}`;
          if (r.status !== "suspected") {
            if (r.status === "confirmed") {
              s.counters.confirmed++;
              if (r.regression_id && !s.counters.regressions.includes(r.regression_id)) s.counters.regressions.push(r.regression_id);
            } else s.counters.rejected++;
            s.ci++;
          }
        } else s.ci++;
        if (s.ci >= s.pending.length) s.phase = "done";
        return { message: msg };
      }
      s.phase = "done";
      return { message: "done" };
    } finally {
      s.counters.llm_calls += lab.calls - callsBefore;
      void job;
    }
  },
  isDone: (s) => s.phase === "done",
  progress: (s) => {
    const total = totalOf(s);
    return { done: s.phase === "done" ? total : Math.min(doneOf(s), total), total };
  },
  result: (s) => ({
    campaign_id: s.campaign_id,
    phase: s.phase,
    agents: s.agents.length,
    attacks: s.attack_ids.length,
    generated: { created: s.gen.created, rejected: s.gen.rejected },
    probes: s.counters.probes,
    breaches: { found: s.counters.breaches, already_confirmed: s.counters.known, confirmed: s.counters.confirmed, rejected: s.counters.rejected, pending: Math.max(0, s.pending.length - s.ci), contained_by_gateway: s.counters.contained },
    regressions_added: s.counters.regressions,
    llm_calls: s.counters.llm_calls,
  }),
  async onFinish(env, job, s, end) {
    await audit(env.DB, "system:redteam", "redteam.campaign", job.id, { status: end.status, stopped: end.stopped ?? null, probes: s.counters.probes, breaches: s.counters.breaches, confirmed: s.counters.confirmed, rejected: s.counters.rejected, regressions: s.counters.regressions.length, generated: s.gen.created.length, llm_calls: end.llm_calls });
  },
};

export const REDTEAM_HANDLERS: Record<string, JobHandler> = { [REDTEAM_CAMPAIGN_KIND]: redteamCampaignJob };

/** Integration helper: registers the arena's job kinds in a handler table (e.g. jobs/handlers.ts HANDLERS). */
export function registerRedteamHandlers(handlers: Record<string, JobHandler>): void {
  Object.assign(handlers, REDTEAM_HANDLERS);
}
