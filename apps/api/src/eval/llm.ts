import type { Env } from "../env";
import type { ModelPolicy } from "../genome/schema";
import { Governor, GovernorError } from "../governor/governor";
import { GEMINI_FLASH, GEMINI_FLASH_LATEST, GEMINI_LITE, LlmRouterError, ModelRouter, WORKERS_AI_MID, WORKERS_AI_STRONG } from "../llm/router";
import type { LlmRequest, LlmResponse } from "../llm/types";

export class LabBudgetError extends Error {
  constructor(
    public scope: "tick" | "daily" | "killed",
    message: string,
  ) {
    super(message);
  }
}

/** Free judge models in preference order (real mode). Gemini models are rotated daily among themselves (judgeOrder). */
export const REAL_JUDGES = [
  GEMINI_FLASH,
  GEMINI_LITE,
  GEMINI_FLASH_LATEST,
  "openrouter:meta-llama/llama-3.3-70b-instruct:free",
  "openrouter:deepseek/deepseek-chat-v3-0324:free",
  WORKERS_AI_STRONG,
  WORKERS_AI_MID,
];
export const MOCK_JUDGES = ["mock:judge-a", "mock:judge-b"];
/** Rough neurons for one 70B judge call (~1.5k prompt + ~300 output tokens) — only used to pick judges. */
const JUDGE_NEURON_HINT = 110;

/**
 * Every LLM call the Eval Factory and Evolution Loop make goes through here:
 *  1. global kill switch → stop;  2. per-tick call budget;  3. the daily "lab" ledger (a share of the
 *  org's free LLM quota, owner-tunable);  4. the normal router, which debits the per-agent + provider
 *  caps and rotates keys. Lab work can therefore never starve the agents' own day.
 */
export class LabLLM {
  calls = 0;
  tokens = 0;
  /** Calls answered from the D1 cache (not counted in `calls`). */
  cachedHits = 0;
  private gov: Governor;
  constructor(
    private env: Env,
    private opts: { maxCalls: number; share: number },
  ) {
    this.gov = new Governor(env);
  }

  get remaining() {
    return Math.max(0, this.opts.maxCalls - this.calls);
  }
  get mode(): "mock" | "auto" {
    return new ModelRouter(this.env).mode;
  }

  async dailyCap(): Promise<number> {
    const caps = await this.gov.caps();
    return Math.max(1, Math.floor(caps.global.llm_calls * this.opts.share));
  }

  /** Reserve `n` calls up front (used when a sub-step, e.g. a sandbox run, spends calls elsewhere). */
  async take(n = 1): Promise<void> {
    if ((await this.gov.isKilled()).killed) throw new LabBudgetError("killed", "global kill switch is ON");
    if (this.calls + n > this.opts.maxCalls) throw new LabBudgetError("tick", `tick budget of ${this.opts.maxCalls} LLM calls used`);
    if (!(await this.gov.debitOne("lab", "llm_calls", n, await this.dailyCap()))) throw new LabBudgetError("daily", "daily lab LLM budget used");
    this.calls += n;
  }

  async complete(agentId: string, req: LlmRequest, policy?: Partial<ModelPolicy>, opts: { only?: boolean; pinned?: boolean } = {}): Promise<LlmResponse> {
    await this.take(1);
    const router = new ModelRouter(this.env, { agentId });
    try {
      const res = await router.complete(req, policy, opts);
      this.tokens += res.tokensIn + res.tokensOut;
      // A D1 cache hit spends no provider quota: give the call back to the daily lab ledger AND to this tick/job's
      // budget. (A job step that is retried after a stop replays its earlier calls from the cache; counting those
      // made a big validation step re-spend its whole budget on replays and never finish — seen live 2026-10-12.)
      if (res.cached) {
        await this.gov.refund("lab", "llm_calls", 1);
        this.calls = Math.max(0, this.calls - 1);
        this.cachedHits++;
      }
      return res;
    } catch (e) {
      // No provider answered (every attempt failed or was skipped): nothing was spent against the free quota.
      if (e instanceof LlmRouterError || e instanceof GovernorError) await this.gov.refund("lab", "llm_calls", 1);
      if (e instanceof GovernorError && e.code === "budget_exhausted") throw new LabBudgetError("daily", e.message);
      if (e instanceof GovernorError && e.code === "killed") throw new LabBudgetError("killed", e.message);
      throw e;
    }
  }

  /**
   * Judge models for today: ≥2 DISTINCT models, rotated daily (anti-Goodhart).
   * Gemini first (since 2026-10-12): when two Gemini models are available the panel is two Gemini models, so the
   * Workers AI neuron budget is left for the weak baseline; otherwise one Gemini model + the next best distinct
   * provider (OpenRouter 70B, then Workers AI 70B). Without Gemini it is the old distinct-provider rotation.
   */
  judgeModels(n = 2, day = new Date().toISOString().slice(0, 10)): string[] {
    return this.judgeOrder(day).slice(0, Math.max(2, n));
  }

  /** Full preference order of usable judge models (mock judges when <2 real models are configured). */
  judgeOrder(day = new Date().toISOString().slice(0, 10)): string[] {
    const router = new ModelRouter(this.env);
    if (router.mode === "mock") return [...MOCK_JUDGES];
    const avail = REAL_JUDGES.filter((m) => router.chain({ primary: m, fallbacks: [], temperature: 0 }, true).length > 0);
    if (avail.length < 2) return MOCK_JUDGES.slice(0, 2); // no two real providers configured → deterministic local judges
    const rot = day.split("-").reduce((s, x) => s + Number(x), 0);
    const rotate = (a: string[]) => (a.length ? [...a.slice(rot % a.length), ...a.slice(0, rot % a.length)] : a);
    const gem = avail.filter((m) => m.startsWith("gemini:"));
    const rest = avail.filter((m) => !m.startsWith("gemini:"));
    if (gem.length) return [...rotate(gem), ...rest];
    const rotated = rotate(avail);
    const out: string[] = [];
    for (const m of rotated) if (!out.some((o) => o.split(":")[0] === m.split(":")[0])) out.push(m); // distinct providers first
    for (const m of rotated) if (!out.includes(m)) out.push(m);
    return out;
  }

  /**
   * judgeModels, but skipping models whose daily budget (provider calls, Gemini per-model RPD, Workers AI
   * neurons) is already used up, so a panel can move on to the next distinct model instead of stopping.
   * Still ≥2 distinct models; if fewer than 2 have budget left the normal panel is returned and its calls
   * fail with the usual daily-budget stop.
   */
  async judgeModelsLive(n = 2, day?: string): Promise<string[]> {
    const want = Math.max(2, n);
    const order = this.judgeOrder(day);
    if (order.every((m) => m.startsWith("mock:"))) return order.slice(0, want);
    const ok: string[] = [];
    for (const m of order) {
      const provider = m.split(":")[0];
      if ((await this.gov.providerBudget(provider, m, provider === "workers-ai" ? JUDGE_NEURON_HINT : 0)).ok) ok.push(m);
      if (ok.length >= want) return ok;
    }
    return order.slice(0, want);
  }
}
