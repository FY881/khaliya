import { CONSTITUTION } from "../constitution";
import type { Env } from "../env";
import { audit } from "../audit";
import { safeJsonParse, today } from "../util";
import { deriveCaps, GEMINI_UNKNOWN_RPD, type DerivedCaps } from "./quotas";
import { keyList } from "../llm/keys";

export type Metric = "llm_calls" | "tokens" | "tool_calls" | "runs";

export class GovernorError extends Error {
  constructor(public code: "killed" | "budget_exhausted" | "population_cap" | "not_runnable", message: string) {
    super(message);
  }
}

/** Keys in governor_state. No agent tool can touch this table (constitution art. 4). */
const K = {
  killGlobal: "kill.global",
  killAgent: (id: string) => `kill.agent:${id}`,
  overrides: "caps.overrides",
};

export interface CapOverrides {
  margin?: number;
  population_live?: number;
}

export class Governor {
  constructor(private env: Env) {}

  private get db() {
    return this.env.DB;
  }

  async getState(key: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT value FROM governor_state WHERE key = ?1").bind(key).first<{ value: string }>();
    return r?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO governor_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(key, value, Date.now())
      .run();
  }

  // ---------- kill switches ----------
  async isKilled(agentId?: string): Promise<{ killed: boolean; scope?: "global" | "agent" }> {
    const keys = [K.killGlobal, ...(agentId ? [K.killAgent(agentId)] : [])];
    const rows = (
      await this.db
        .prepare(`SELECT key, value FROM governor_state WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(",")})`)
        .bind(...keys)
        .all<{ key: string; value: string }>()
    ).results;
    for (const r of rows) {
      if (r.value === "1") return { killed: true, scope: r.key === K.killGlobal ? "global" : "agent" };
    }
    return { killed: false };
  }

  async setKill(scope: "global" | { agent: string }, on: boolean, actor = "owner"): Promise<void> {
    const key = scope === "global" ? K.killGlobal : K.killAgent(scope.agent);
    await this.setState(key, on ? "1" : "0");
    await audit(this.db, actor, on ? "kill.on" : "kill.off", scope === "global" ? "global" : `agent:${scope.agent}`);
  }

  async killedAgents(): Promise<string[]> {
    const rows = (
      await this.db.prepare("SELECT key FROM governor_state WHERE key LIKE 'kill.agent:%' AND value = '1'").all<{ key: string }>()
    ).results;
    return rows.map((r) => r.key.slice("kill.agent:".length));
  }

  // ---------- caps ----------
  async overrides(): Promise<CapOverrides> {
    return safeJsonParse<CapOverrides>(await this.getState(K.overrides)) ?? {};
  }

  async setOverrides(o: CapOverrides, actor = "owner"): Promise<void> {
    const clean: CapOverrides = {};
    if (o.margin !== undefined) clean.margin = Math.min(Math.max(Number(o.margin), 0.1), 0.9);
    if (o.population_live !== undefined) clean.population_live = Math.min(Math.max(Math.floor(Number(o.population_live)), 1), 64);
    await this.setState(K.overrides, JSON.stringify(clean));
    this.capsMemo = undefined;
    await audit(this.db, actor, "governor.caps.update", "caps", clean);
  }

  private capsMemo?: { at: number; caps: DerivedCaps };

  async caps(): Promise<DerivedCaps> {
    if (this.capsMemo && Date.now() - this.capsMemo.at < 5000) return this.capsMemo.caps;
    const o = await this.overrides();
    const mock = (this.env.LLM_MODE ?? "auto") === "mock" || (!this.env.GEMINI_KEY && !this.env.OPENROUTER_KEY);
    const caps = deriveCaps({
      margin: o.margin ?? Number(this.env.QUOTA_MARGIN ?? CONSTITUTION.quotaMargin),
      geminiKeys: keyList(this.env.GEMINI_KEY).length,
      openrouterKeys: keyList(this.env.OPENROUTER_KEY).length,
      workersAi: !!this.env.AI,
      populationCap: o.population_live ?? Number(this.env.POPULATION_CAP ?? CONSTITUTION.populationCap.live),
      includeMock: mock,
    });
    this.capsMemo = { at: Date.now(), caps };
    return caps;
  }

  /**
   * Atomically add `amount` to a daily ledger row iff it stays within `cap`.
   * Returns false (and changes nothing) when it would exceed the cap.
   */
  async debitOne(scope: string, metric: Metric | string, amount: number, cap: number, day = today()): Promise<boolean> {
    if (amount <= 0) return true;
    if (amount > cap) return false;
    const r = await this.db
      .prepare(
        `INSERT INTO budgets (day, scope, metric, used, cap) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(day, scope, metric) DO UPDATE SET used = budgets.used + excluded.used, cap = excluded.cap
         WHERE budgets.used + excluded.used <= excluded.cap
         RETURNING used`,
      )
      .bind(day, scope, metric, amount, cap)
      .first<{ used: number }>();
    return r !== null;
  }

  async refund(scope: string, metric: string, amount: number, day = today()): Promise<void> {
    await this.db
      .prepare("UPDATE budgets SET used = MAX(0, used - ?4) WHERE day = ?1 AND scope = ?2 AND metric = ?3")
      .bind(day, scope, metric, amount)
      .run();
  }

  /**
   * Daily call cap of one model ("provider:model"), or null when only its provider cap applies.
   * Gemini free quotas are per model, so every Gemini model has one (unknown ids get GEMINI_UNKNOWN_RPD).
   */
  modelCap(caps: DerivedCaps, modelId?: string): number | null {
    if (!modelId) return null;
    if (modelId in caps.model) return caps.model[modelId];
    if (modelId.startsWith("gemini:")) return Math.floor(GEMINI_UNKNOWN_RPD * keyList(this.env.GEMINI_KEY).length * caps.margin);
    return null;
  }

  /** Debit global + agent scopes (and optional provider + model scopes). All-or-nothing. */
  async debit(agentId: string, metric: Metric, amount: number, provider?: string, modelId?: string): Promise<{ ok: boolean; scope?: string }> {
    const caps = await this.caps();
    const plan: [string, number][] = [
      ["global", caps.global[metric]],
      [`agent:${agentId}`, caps.per_agent[metric]],
    ];
    if (provider && metric === "llm_calls") plan.push([`provider:${provider}`, (caps.provider as Record<string, number>)[provider] ?? 0]);
    const mc = metric === "llm_calls" ? this.modelCap(caps, modelId) : null;
    if (mc !== null) plan.push([`model:${modelId}`, mc]);
    const done: string[] = [];
    for (const [scope, cap] of plan) {
      if (!(await this.debitOne(scope, metric, amount, cap))) {
        for (const s of done) await this.refund(s, metric, amount);
        return { ok: false, scope };
      }
      done.push(scope);
    }
    return { ok: true };
  }

  /** Record usage that has already happened (e.g. tokens returned by a provider); never blocks. */
  async record(agentId: string, metric: Metric, amount: number): Promise<void> {
    if (amount <= 0) return;
    const caps = await this.caps();
    const day = today();
    const stmt = this.db.prepare(
      `INSERT INTO budgets (day, scope, metric, used, cap) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(day, scope, metric) DO UPDATE SET used = budgets.used + excluded.used, cap = excluded.cap`,
    );
    await this.db.batch([
      stmt.bind(day, "global", metric, amount, caps.global[metric]),
      stmt.bind(day, `agent:${agentId}`, metric, amount, caps.per_agent[metric]),
    ]);
  }

  /** True when neither the global nor the agent's ledger for `metric` is at/over its cap. */
  async withinCap(agentId: string, metric: Metric): Promise<{ ok: boolean; scope?: string }> {
    const caps = await this.caps();
    const rows = (
      await this.db
        .prepare("SELECT scope, used FROM budgets WHERE day = ?1 AND metric = ?2 AND scope IN ('global', ?3)")
        .bind(today(), metric, `agent:${agentId}`)
        .all<{ scope: string; used: number }>()
    ).results;
    for (const r of rows) {
      const cap = r.scope === "global" ? caps.global[metric] : caps.per_agent[metric];
      if (r.used >= cap) return { ok: false, scope: r.scope };
    }
    return { ok: true };
  }

  async refundAll(agentId: string, metric: Metric, amount: number, provider?: string, modelId?: string): Promise<void> {
    await this.refund("global", metric, amount);
    await this.refund(`agent:${agentId}`, metric, amount);
    if (provider) await this.refund(`provider:${provider}`, metric, amount);
    if (modelId && metric === "llm_calls" && this.modelCap(await this.caps(), modelId) !== null) await this.refund(`model:${modelId}`, metric, amount);
  }

  /**
   * Is there budget left for one call to `modelId` on `provider`? Checks the provider's daily call cap, the
   * model's own cap (Gemini), and for Workers AI that `neurons` more neurons still fit under the neuron cap.
   * Returns the reason when not ("calls" | "model" | "neurons").
   */
  async providerBudget(provider: string, modelId?: string, neurons = 0): Promise<{ ok: boolean; reason?: "calls" | "model" | "neurons" }> {
    const caps = await this.caps();
    const cap = (caps.provider as Record<string, number>)[provider] ?? 0;
    if (cap <= 0) return { ok: false, reason: "calls" };
    const mc = this.modelCap(caps, modelId);
    if (mc !== null && mc <= 0) return { ok: false, reason: "model" };
    const rows = (
      await this.db
        .prepare("SELECT scope, metric, used FROM budgets WHERE day = ?1 AND scope IN (?2, ?3)")
        .bind(today(), `provider:${provider}`, `model:${modelId ?? ""}`)
        .all<{ scope: string; metric: string; used: number }>()
    ).results;
    const used = (scope: string, metric: string) => rows.find((r) => r.scope === scope && r.metric === metric)?.used ?? 0;
    if (used(`provider:${provider}`, "llm_calls") >= cap) return { ok: false, reason: "calls" };
    if (mc !== null && used(`model:${modelId}`, "llm_calls") >= mc) return { ok: false, reason: "model" };
    if (provider === "workers-ai" && used("provider:workers-ai", "neurons") + Math.max(1, neurons) > caps.neurons["workers-ai"]) return { ok: false, reason: "neurons" };
    return { ok: true };
  }

  async providerHasBudget(provider: string, modelId?: string): Promise<boolean> {
    return (await this.providerBudget(provider, modelId)).ok;
  }

  /** Reserve Workers AI neurons up front (atomic; false = would exceed the daily neuron cap). */
  async reserveNeurons(n: number): Promise<boolean> {
    const caps = await this.caps();
    return this.debitOne("provider:workers-ai", "neurons", Math.max(1, Math.ceil(n)), caps.neurons["workers-ai"]);
  }

  /** Settle a reservation with the actual neuron cost (refund the difference or record the overrun; never blocks). */
  async settleNeurons(reserved: number, actual: number): Promise<void> {
    const r = Math.max(1, Math.ceil(reserved));
    const a = Math.max(0, Math.ceil(actual));
    if (a < r) return this.refund("provider:workers-ai", "neurons", r - a);
    if (a > r) {
      const caps = await this.caps();
      await this.db
        .prepare(
          `INSERT INTO budgets (day, scope, metric, used, cap) VALUES (?1, 'provider:workers-ai', 'neurons', ?2, ?3)
           ON CONFLICT(day, scope, metric) DO UPDATE SET used = budgets.used + excluded.used, cap = excluded.cap`,
        )
        .bind(today(), a - r, caps.neurons["workers-ai"])
        .run();
    }
  }

  async usage(day = today()): Promise<{ scope: string; metric: string; used: number; cap: number }[]> {
    return (
      await this.db.prepare("SELECT scope, metric, used, cap FROM budgets WHERE day = ?1 ORDER BY scope, metric").bind(day).all<any>()
    ).results;
  }

  // ---------- population ----------
  async assertPopulationRoom(status: string): Promise<void> {
    const caps = await this.caps();
    const r = await this.db
      .prepare(
        "SELECT SUM(CASE WHEN status NOT IN ('retired') THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN status IN ('candidate','sandboxed','draft') THEN 1 ELSE 0 END) AS cand FROM agents",
      )
      .first<{ live: number | null; cand: number | null }>();
    const live = r?.live ?? 0;
    const cand = r?.cand ?? 0;
    if (live >= caps.population.live) throw new GovernorError("population_cap", `population cap reached (${live}/${caps.population.live})`);
    if (["candidate", "sandboxed", "draft"].includes(status) && cand >= caps.population.candidates)
      throw new GovernorError("population_cap", `candidate cap reached (${cand}/${caps.population.candidates})`);
  }

  /** Called before every run step. Throws if the run must stop. */
  async assertMayContinue(agentId: string): Promise<void> {
    const k = await this.isKilled(agentId);
    if (k.killed) throw new GovernorError("killed", `kill switch (${k.scope}) is ON`);
  }
}
