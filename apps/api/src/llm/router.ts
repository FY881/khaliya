import type { Env } from "../env";
import { isFreeModel, type ModelPolicy } from "../genome/schema";
import { Governor, GovernorError } from "../governor/governor";
import { GEMINI_FREE_RPM, GEMINI_UNKNOWN_RPM, neuronsFor } from "../governor/quotas";
import { canonicalJson, estimateTokens, sha256Hex } from "../util";
import { keyList } from "./keys";
import { defaultMockScript, gemini, mockProvider, openrouter, workersAi, type MockScript } from "./providers";
import { ProviderError, type Fetcher, type LlmRequest, type LlmResponse, type Provider } from "./types";

/** Workers AI models verified live (2026-10-12) — the free last-resort tier. */
export const WORKERS_AI_STRONG = "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORKERS_AI_MID = "workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct";
/** Small, current models: only the WEAK validation baseline uses them (never part of the default chain). */
export const WORKERS_AI_SMALL = ["workers-ai:@cf/meta/llama-3.2-1b-instruct", "workers-ai:@cf/meta/llama-3.2-3b-instruct"];

/** Default free chain appended after the genome's own policy. Override per genome. */
/** Pinned current Gemini Flash (verified live 2026-10-12; the "-latest" alias was intermittently 503 "high demand"). */
export const GEMINI_FLASH = "gemini:gemini-3.5-flash";
export const GEMINI_FLASH_LATEST = "gemini:gemini-flash-latest";
export const GEMINI_LITE = "gemini:gemini-flash-lite-latest";

export const DEFAULT_CHAIN = [
  GEMINI_LITE,
  GEMINI_FLASH_LATEST,
  GEMINI_FLASH,
  "openrouter:meta-llama/llama-3.3-70b-instruct:free",
  "openrouter:deepseek/deepseek-chat-v3-0324:free",
  WORKERS_AI_STRONG,
  WORKERS_AI_MID,
];

/**
 * Retired model ids. Genomes created before a retirement may still name them; the router drops them from
 * every chain instead of spending a failing call on each request.
 */
export const DEPRECATED_MODELS = new Set<string>([
  "workers-ai:@cf/meta/llama-3.1-8b-instruct", // Workers AI error 5028: deprecated 2026-05-30
]);
const DEPRECATED_RE = /\b5028\b|deprecat/i;

const CACHE_TTL_MS = 60 * 60 * 1000;
/** attempts[].detail prefix for "this provider/model is out of today's budget" (calls, model RPD or neurons). */
export const CAP_SKIP = "provider daily cap";
const TRANSIENT = new Set([500, 503, 504]);

/** Per-isolate key cooldowns: "provider#index" → epoch ms until usable. */
const cooldowns = new Map<string, number>();
const cursors = new Map<string, number>();

/** Models that answered "deprecated" at runtime (per isolate). */
const runtimeRetired = new Set<string>();
export const isRetired = (m: string) => DEPRECATED_MODELS.has(m) || runtimeRetired.has(m);

/** Per-isolate request log for RPM pacing: "gemini#key#model" → call timestamps within the last minute. */
const paceLog = new Map<string, number[]>();
/**
 * Pacing limits. One sleep for a model's next per-minute slot is at most PACE_MAX_WAIT_MS (otherwise the model is
 * skipped as "cooling down (rpm)" and the chain moves on); and the whole complete() call may sleep at most
 * PACE_BUDGET_MS IN TOTAL (one RPM window + 1 s). Before 2026-10-12 every model of the chain could sleep 30 s on
 * its own (and the pacing loop could re-sleep), so a chain of Gemini models could stall a job chunk for minutes.
 */
export const PACE_MAX_WAIT_MS = 30_000;
export const PACE_BUDGET_MS = 61_000;
/** Per-call ceiling for one provider request (fetch is aborted via AbortSignal; Workers AI calls are raced). */
export const LLM_CALL_TIMEOUT_MS = 50_000;
/** Status used for a timed-out provider call: not "transient" (no same-model retry), so the chain moves on. */
export const TIMEOUT_STATUS = 598;

export function resetRouterState(): void {
  paceLog.clear();
  cooldowns.clear();
  cursors.clear();
  runtimeRetired.clear();
}

export interface RouterAttempt {
  model: string;
  keyIndex?: number;
  status: "ok" | "rate_limited" | "auth" | "error" | "skipped";
  detail?: string;
}

export interface RouterOptions {
  fetcher?: Fetcher;
  agentId?: string; // when set, daily caps are debited through the Governor
  mockScript?: MockScript;
  providers?: Partial<Record<string, Provider>>; // test injection
  now?: () => number;
  /** Delay before the single retry of a transient 5xx (default 1.5 s; tests use 0). */
  transientDelayMs?: number;
  /** Total RPM-pacing sleep allowed per complete() call (default PACE_BUDGET_MS). */
  paceBudgetMs?: number;
  /** Per-provider-call timeout (default LLM_CALL_TIMEOUT_MS). */
  callTimeoutMs?: number;
}

export class LlmRouterError extends Error {
  constructor(
    message: string,
    public attempts: RouterAttempt[],
  ) {
    super(message);
  }
}

export class ModelRouter {
  readonly attempts: RouterAttempt[] = [];
  private providers: Record<string, Provider>;
  private fetcher: Fetcher;
  private governor: Governor;
  private now: () => number;

  constructor(
    private env: Env,
    private opts: RouterOptions = {},
  ) {
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.governor = new Governor(env);
    this.now = opts.now ?? Date.now;
    this.providers = {
      gemini,
      openrouter,
      "workers-ai": workersAi(env.AI),
      mock: mockProvider(opts.mockScript ?? defaultMockScript),
      ...(opts.providers as Record<string, Provider>),
    };
  }

  get mode(): "mock" | "auto" {
    return (this.env.LLM_MODE ?? "auto") === "mock" ? "mock" : "auto";
  }

  keysFor(provider: string): string[] {
    if (provider === "gemini") return keyList(this.env.GEMINI_KEY);
    if (provider === "openrouter") return keyList(this.env.OPENROUTER_KEY);
    return [];
  }

  available(provider: string): boolean {
    const p = this.providers[provider];
    if (!p) return false;
    if (provider === "mock") return true;
    if (provider === "workers-ai") return !!this.env.AI || !!this.opts.providers?.["workers-ai"];
    return !p.needsKey || this.keysFor(provider).length > 0;
  }

  /**
   * Ordered, de-duplicated list of free models to try.
   * `only` = use exactly the policy's primary model (no fallbacks) — the judge panel needs this so two
   * "different" judges can never silently collapse onto the same fallback model.
   */
  chain(policy?: Partial<ModelPolicy>, only = false, pinned = false): string[] {
    if (this.mode === "mock") return policy?.primary?.startsWith("mock:") ? [policy.primary] : ["mock:default"];
    if (only) {
      const m = policy?.primary;
      if (m?.startsWith("mock:")) return [m]; // explicit request for a deterministic local grader
      if (!m || !isFreeModel(m) || m.startsWith("mock:") || isRetired(m) || !this.available(m.split(":")[0])) return [];
      return [m];
    }
    // pinned = the policy's own models only (no DEFAULT_CHAIN). The weak baseline needs this: falling back
    // to a strong default model would silently turn "weak" into "strong" and break the discriminative gate.
    const raw = [policy?.primary, ...(policy?.fallbacks ?? []), ...(pinned ? [] : DEFAULT_CHAIN)].filter(Boolean) as string[];
    const out = [...new Set(raw)].filter((m) => isFreeModel(m) && !m.startsWith("mock:") && !isRetired(m));
    if (pinned) return out.filter((m) => this.available(m.split(":")[0]));
    const usable = out.filter((m) => this.available(m.split(":")[0]));
    // No real provider configured at all → deterministic mock so local dev still works.
    return usable.length ? usable : ["mock:default"];
  }

  /** Pacing sleep left for this router's current complete() call. */
  private paceLeftMs = PACE_BUDGET_MS;
  /** Total ms slept for pacing by this router (diagnostics/tests). */
  pacedMs = 0;

  /**
   * Sliding-window RPM pacing (per isolate). Sleeps only while the request's shared pacing budget allows;
   * false = the next slot is further away than the budget left (caller skips the model as cooling down).
   */
  private async pace(key: string, rpm: number): Promise<boolean> {
    if (rpm <= 0) return false;
    for (let guard = 0; guard < 4; guard++) {
      const now = Date.now();
      const log = (paceLog.get(key) ?? []).filter((t) => t > now - 60_000);
      if (log.length < rpm) {
        log.push(now);
        paceLog.set(key, log);
        return true;
      }
      const wait = Math.max(1, log[0] + 60_000 - now + 25);
      if (wait > PACE_MAX_WAIT_MS || wait > this.paceLeftMs) return false;
      this.paceLeftMs -= wait;
      this.pacedMs += wait;
      await new Promise((r) => setTimeout(r, wait));
    }
    return false;
  }

  /** One provider call with a hard timeout: fetch gets an AbortSignal, everything else (AI binding, mocks) is raced. */
  private async callWithTimeout(provider: Provider, model: string, req: LlmRequest, key: string | undefined): Promise<LlmResponse> {
    const ms = Math.max(1, this.opts.callTimeoutMs ?? LLM_CALL_TIMEOUT_MS);
    const ctl = new AbortController();
    const base = this.fetcher;
    const fetcher: Fetcher = (input, init) => base(input, { ...(init ?? {}), signal: init?.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, ctl.signal]) : ctl.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctl.abort();
        rej(new ProviderError(`${provider.name}: timeout after ${Math.round(ms / 1000)} s`, TIMEOUT_STATUS));
      }, ms);
    });
    try {
      return await Promise.race([provider.call({ model, req, key, fetcher }), timeout]);
    } catch (e) {
      if (ctl.signal.aborted && !(e instanceof ProviderError && e.status === TIMEOUT_STATUS)) throw new ProviderError(`${provider.name}: timeout after ${Math.round(ms / 1000)} s`, TIMEOUT_STATUS);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async cacheKey(req: LlmRequest, chain: string[]): Promise<string> {
    return sha256Hex(canonicalJson({ chain: chain[0], m: req.messages, t: req.temperature ?? 0, j: !!req.json }));
  }

  async complete(req: LlmRequest, policy?: Partial<ModelPolicy>, opts: { only?: boolean; pinned?: boolean } = {}): Promise<LlmResponse> {
    const chain = this.chain(policy, opts.only, opts.pinned);
    this.paceLeftMs = Math.max(0, this.opts.paceBudgetMs ?? PACE_BUDGET_MS);
    if (!chain.length) throw new LlmRouterError(`model '${policy?.primary}' is not available`, this.attempts);
    const useCache = req.cache === true || (req.temperature ?? policy?.temperature) === 0;
    let ck: string | undefined;
    if (useCache) {
      ck = await this.cacheKey(req, chain);
      const hit = await this.env.DB.prepare("SELECT response FROM llm_cache WHERE key = ?1 AND expires_at > ?2")
        .bind(ck, this.now())
        .first<{ response: string }>();
      if (hit) return { ...(JSON.parse(hit.response) as LlmResponse), cached: true };
    }

    for (const modelId of chain) {
      const idx = modelId.indexOf(":");
      const providerName = modelId.slice(0, idx);
      const model = modelId.slice(idx + 1);
      const provider = this.providers[providerName];
      if (!provider) continue;

      // Workers AI is budgeted in neurons: reserve the worst case (prompt + full maxTokens), settle to actual.
      const promptTok = providerName === "workers-ai" ? estimateTokens(req.messages.map((m) => m.content).join("\n")) : 0;
      const neuronEst = providerName === "workers-ai" ? neuronsFor(model, promptTok, req.maxTokens ?? 1024) : 0;
      if (this.opts.agentId) {
        const b = await this.governor.providerBudget(providerName, modelId, neuronEst);
        if (!b.ok) {
          this.attempts.push({ model: modelId, status: "skipped", detail: b.reason === "calls" ? CAP_SKIP : `${CAP_SKIP} (${b.reason})` });
          continue;
        }
      }

      const keys = provider.needsKey ? this.keysFor(providerName) : [undefined];
      const start = cursors.get(providerName) ?? 0;
      for (let n = 0; n < keys.length; n++) {
        const ki = (start + n) % keys.length;
        // Gemini limits (RPM/RPD) are per MODEL, so a 429 on one Gemini model must not park the key for the others.
        const cdKey = providerName === "gemini" ? `${providerName}#${ki}#${model}` : `${providerName}#${ki}`;
        if ((cooldowns.get(cdKey) ?? 0) > this.now()) {
          this.attempts.push({ model: modelId, keyIndex: ki, status: "skipped", detail: "key cooling down" });
          continue;
        }
        // Stay under the model's free requests/minute instead of burning calls on 429s (seen live 2026-10-12).
        if (providerName === "gemini" && !(await this.pace(cdKey, GEMINI_FREE_RPM[model] ?? GEMINI_UNKNOWN_RPM))) {
          this.attempts.push({ model: modelId, keyIndex: ki, status: "skipped", detail: "key cooling down (rpm)" });
          continue;
        }
        if (this.opts.agentId) {
          const t = await this.governor.withinCap(this.opts.agentId, "tokens");
          if (!t.ok) throw new GovernorError("budget_exhausted", `daily tokens cap reached (${t.scope})`);
          const d = await this.governor.debit(this.opts.agentId, "llm_calls", 1, providerName, modelId);
          if (!d.ok && (d.scope?.startsWith("provider:") || d.scope?.startsWith("model:"))) {
            // lost a race for the provider/model cap: try the next model rather than failing the whole call
            this.attempts.push({ model: modelId, status: "skipped", detail: `${CAP_SKIP} (${d.scope.startsWith("model:") ? "model" : "calls"})` });
            break;
          }
          if (!d.ok) throw new GovernorError("budget_exhausted", `daily llm_calls cap reached (${d.scope})`);
          if (neuronEst && !(await this.governor.reserveNeurons(neuronEst))) {
            await this.governor.refundAll(this.opts.agentId, "llm_calls", 1, providerName, modelId);
            this.attempts.push({ model: modelId, status: "skipped", detail: `${CAP_SKIP} (neurons)` });
            break;
          }
        }
        let res: LlmResponse;
        try {
          try {
            res = await this.callWithTimeout(provider, model, req, keys[ki]);
          } catch (e1) {
            // Overloaded / transient server error (Gemini 503 "high demand" was frequent live on 2026-10-12):
            // one quick retry of the same model before moving on. Not for mock/test fetchers' 4xx.
            if (!(e1 instanceof ProviderError) || !TRANSIENT.has(e1.status)) throw e1;
            await new Promise((r) => setTimeout(r, this.opts.transientDelayMs ?? 1500));
            res = await this.callWithTimeout(provider, model, req, keys[ki]);
          }
          if (this.opts.agentId && neuronEst) await this.governor.settleNeurons(neuronEst, neuronsFor(model, res.tokensIn, res.tokensOut));
          res.keyIndex = provider.needsKey ? ki : undefined;
          cursors.set(providerName, (ki + 1) % Math.max(1, keys.length)); // round-robin spread
          this.attempts.push({ model: modelId, keyIndex: res.keyIndex, status: "ok" });
          if (this.opts.agentId) await this.governor.record(this.opts.agentId, "tokens", res.tokensIn + res.tokensOut);
          if (ck) {
            await this.env.DB.prepare(
              "INSERT INTO llm_cache (key, response, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET response = excluded.response, expires_at = excluded.expires_at",
            )
              .bind(ck, JSON.stringify(res), this.now() + CACHE_TTL_MS)
              .run();
          }
          return res;
        } catch (e) {
          if (this.opts.agentId) {
            await this.governor.refundAll(this.opts.agentId, "llm_calls", 1, providerName, modelId);
            // a failed Workers AI call may still have burned some neurons; keep a small charge (prompt only)
            if (neuronEst) await this.governor.settleNeurons(neuronEst, neuronsFor(model, promptTok, 0));
          }
          const pe = e instanceof ProviderError ? e : new ProviderError(String((e as Error)?.message ?? e), 599);
          if (pe.status === 429) {
            // a per-DAY quota will not come back in minutes: park that model for an hour
            cooldowns.set(cdKey, this.now() + (pe.quota === "day" ? 60 * 60_000 : Math.min(pe.retryAfterMs ?? 60_000, 10 * 60_000)));
            this.attempts.push({ model: modelId, keyIndex: ki, status: "rate_limited", detail: pe.message.slice(0, 120) });
            continue; // rotate to next key
          }
          if (pe.status === 401 || pe.status === 402 || pe.status === 403) {
            cooldowns.set(cdKey, this.now() + 60 * 60_000); // bad / unfunded key: park it for an hour
            this.attempts.push({ model: modelId, keyIndex: ki, status: "auth", detail: pe.message.slice(0, 120) });
            continue;
          }
          if (DEPRECATED_RE.test(pe.message)) runtimeRetired.add(modelId); // stop paying for it in this isolate
          this.attempts.push({ model: modelId, keyIndex: ki, status: "error", detail: pe.message.slice(0, 120) });
          break; // model/provider problem → next model in chain
        }
      }
    }
    // Every model was skipped because its provider's daily cap is used up: that is the Governor's budget, not an
    // outage — callers (LabLLM → LabBudgetError "daily", jobs → stopped: daily_budget) must stop, not retry.
    if (this.attempts.length && this.attempts.every((a) => a.status === "skipped" && a.detail?.startsWith(CAP_SKIP)))
      throw new GovernorError("budget_exhausted", `provider daily caps reached (${[...new Set(this.attempts.map((a) => a.model.split(":")[0]))].join(", ")})`);
    throw new LlmRouterError("all free providers failed or are rate-limited", this.attempts);
  }
}
