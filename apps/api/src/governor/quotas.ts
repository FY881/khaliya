/**
 * Free-tier quotas (defaults). The Governor uses at most QUOTA_MARGIN (default 70%) of each.
 * Provider numbers are conservative defaults; check your live limits in Google AI Studio
 * (https://aistudio.google.com/rate-limit) and OpenRouter (GET /api/v1/key) and override via
 * the Governor settings if they differ. NOTE: Gemini limits are per Google Cloud PROJECT, not per
 * key — extra keys only add capacity if they come from different projects.
 */
export const FREE_TIER = Object.freeze({
  workers_requests_day: 100_000,
  do_requests_day: 100_000,
  d1_rows_read_day: 5_000_000,
  d1_rows_written_day: 100_000,
  workers_ai_neurons_day: 10_000,
  queues_ops_day: 10_000,
  providers: Object.freeze({
    // provider-level totals = sum of GEMINI_FREE_RPD (per model, per project); rpm is the strictest model's.
    gemini: Object.freeze({ rpm: 10, rpd: 1500 }),
    openrouter: Object.freeze({ rpm: 20, rpd: 50 }),
    // Workers AI is really limited by NEURONS (see WORKERS_AI_NEURONS / caps.neurons); this rpd is only a
    // sanity ceiling on the call count (a 1B-model call costs ~5–20 neurons → the neuron cap binds first).
    "workers-ai": Object.freeze({ rpm: 300, rpd: 2000 }),
    mock: Object.freeze({ rpm: 100_000, rpd: 1_000_000 }),
  }),
});

export type ProviderName = keyof typeof FREE_TIER.providers;

/**
 * Workers AI neuron rates, neurons per 1M tokens (input / output), copied from the official pricing table
 * https://developers.cloudflare.com/workers-ai/platform/pricing/ (fetched 2026-10-12; page "Last updated Oct 9, 2026").
 * The free allowance is 10,000 neurons/day per account (resets 00:00 UTC).
 */
export const WORKERS_AI_NEURONS: Readonly<Record<string, Readonly<{ in: number; out: number }>>> = Object.freeze({
  "@cf/meta/llama-3.2-1b-instruct": Object.freeze({ in: 2457, out: 18252 }),
  "@cf/meta/llama-3.2-3b-instruct": Object.freeze({ in: 4625, out: 30475 }),
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": Object.freeze({ in: 4119, out: 34868 }),
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": Object.freeze({ in: 26668, out: 204805 }),
  "@cf/meta/llama-4-scout-17b-16e-instruct": Object.freeze({ in: 24545, out: 77273 }),
});
/** Unknown Workers AI model → bill it like the most expensive model we use (70B) so it can never under-count. */
const WORKERS_AI_UNKNOWN = WORKERS_AI_NEURONS["@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

/** Neurons a Workers AI call costs (model id with or without the "workers-ai:" prefix). Always ≥ 1. */
export function neuronsFor(model: string, tokensIn: number, tokensOut: number): number {
  const r = WORKERS_AI_NEURONS[model.replace(/^workers-ai:/, "")] ?? WORKERS_AI_UNKNOWN;
  return Math.max(1, Math.ceil((Math.max(0, tokensIn) * r.in + Math.max(0, tokensOut) * r.out) / 1_000_000));
}

/**
 * Gemini free-tier requests/day PER MODEL (per Google Cloud project; extra keys only help if they come from
 * different projects). Google no longer publishes free-tier numbers in the docs — the live values are at
 * https://aistudio.google.com/rate-limit — so these are conservative defaults; a 429 from Google still
 * parks the key (router), whatever these say. Only models listed here are counted toward the Gemini cap.
 */
export const GEMINI_FREE_RPD: Readonly<Record<string, number>> = Object.freeze({
  "gemini-flash-lite-latest": 1000,
  "gemini-flash-latest": 20, // Google 429 on 2026-10-13: GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20
  "gemini-3.5-flash": 250,
});
/** Gemini free requests/minute per model (conservative defaults; the router paces calls to stay under them). */
export const GEMINI_FREE_RPM: Readonly<Record<string, number>> = Object.freeze({
  "gemini-flash-lite-latest": 15,
  "gemini-flash-latest": 10,
  "gemini-3.5-flash": 10,
});
export const GEMINI_UNKNOWN_RPM = 5;
/** Gemini model not in the table → this many requests/day. */
export const GEMINI_UNKNOWN_RPD = 20;

/** Rough D1 rows written per run (run row, audit, budget upserts, tool audits). */
const D1_WRITES_PER_RUN = 40;

export interface DerivedCaps {
  margin: number;
  global: { llm_calls: number; tokens: number; tool_calls: number; runs: number };
  provider: Record<ProviderName, number>; // llm calls per day
  /** Per-model llm calls per day ("gemini:<model>"); models not listed only count against their provider. */
  model: Record<string, number>;
  /** Workers AI neurons per day (margin × 10,000). The binding constraint for Workers AI. */
  neurons: { "workers-ai": number };
  per_agent: { llm_calls: number; tokens: number; tool_calls: number; runs: number };
  population: { live: number; candidates: number };
}

export function deriveCaps(opts: {
  margin?: number;
  geminiKeys?: number;
  openrouterKeys?: number;
  workersAi?: boolean;
  populationCap?: number;
  includeMock?: boolean;
}): DerivedCaps {
  const margin = Math.min(Math.max(opts.margin ?? 0.7, 0.1), 0.9);
  const P = FREE_TIER.providers;
  const gk = Math.max(0, opts.geminiKeys ?? 0);
  const model: Record<string, number> = {};
  for (const [m, rpd] of Object.entries(GEMINI_FREE_RPD)) model[`gemini:${m}`] = Math.floor(rpd * gk * margin);
  const provider = {
    gemini: Object.values(model).reduce((a, b) => a + b, 0),
    openrouter: Math.floor(P.openrouter.rpd * Math.max(0, opts.openrouterKeys ?? 0) * margin),
    "workers-ai": opts.workersAi === false ? 0 : Math.floor(P["workers-ai"].rpd * margin),
    mock: opts.includeMock ? Math.floor(P.mock.rpd * margin) : 0,
  } as Record<ProviderName, number>;
  const realLlm = provider.gemini + provider.openrouter + provider["workers-ai"];
  // If only mock is available (local dev / tests) give it a sane budget.
  const llm_calls = Math.max(realLlm, opts.includeMock ? 2000 : 0);
  const runsByD1 = Math.floor((FREE_TIER.d1_rows_written_day * margin) / D1_WRITES_PER_RUN);
  const runs = Math.max(1, Math.min(runsByD1, Math.floor(llm_calls / 3)));
  const tool_calls = Math.floor(Math.min(FREE_TIER.do_requests_day * margin, runs * 8));
  const global = { llm_calls, tokens: llm_calls * 2500, tool_calls, runs };
  // An agent may consume at most 25% of the org's daily budget.
  const share = 0.25;
  const per_agent = {
    llm_calls: Math.max(1, Math.floor(global.llm_calls * share)),
    tokens: Math.max(1, Math.floor(global.tokens * share)),
    tool_calls: Math.max(1, Math.floor(global.tool_calls * share)),
    runs: Math.max(1, Math.floor(global.runs * share)),
  };
  const live = Math.max(1, Math.min(opts.populationCap ?? 24, 64));
  const neurons = { "workers-ai": opts.workersAi === false ? 0 : Math.floor(FREE_TIER.workers_ai_neurons_day * margin) };
  return { margin, global, provider, model, neurons, per_agent, population: { live, candidates: Math.max(1, Math.floor(live / 2)) } };
}
