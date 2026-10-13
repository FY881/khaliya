/**
 * Neuron-aware Workers AI budget, per-model Gemini caps, Gemini thinking handling and Gemini-first judges.
 * All providers are mocked: no network, no real Workers AI.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { judge, type JudgeItem } from "../src/eval/judge";
import type { Env } from "../src/env";
import { LabLLM } from "../src/eval/llm";
import { Governor, GovernorError } from "../src/governor/governor";
import { deriveCaps, FREE_TIER, GEMINI_FREE_RPD, neuronsFor, WORKERS_AI_NEURONS } from "../src/governor/quotas";
import { GEMINI_THINKING_HEADROOM } from "../src/llm/providers";
import { CAP_SKIP, GEMINI_FLASH, GEMINI_LITE, ModelRouter, WORKERS_AI_SMALL, WORKERS_AI_STRONG } from "../src/llm/router";
import type { Provider } from "../src/llm/types";
import { freshState } from "./helpers";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

const today = () => new Date().toISOString().slice(0, 10);
const req = (maxTokens = 64) => ({ messages: [{ role: "user" as const, content: "hello there" }], maxTokens });

/** Real-mode env with Workers AI "bound" (the provider itself is injected, so nothing remote is touched). */
function waEnv(over: Partial<Env> = {}): Env {
  return { ...(env as Env), LLM_MODE: "auto", GEMINI_KEY: "k1", OPENROUTER_KEY: undefined, AI: {} as Ai, ...over };
}
function fakeWorkersAi(tokensIn = 100, tokensOut = 50, calls: string[] = []): Provider {
  return {
    name: "workers-ai",
    needsKey: false,
    async call({ model }) {
      calls.push(model);
      return { text: "ok", model: `workers-ai:${model}`, provider: "workers-ai", tokensIn, tokensOut };
    },
  };
}
const geminiOk = (text = "hi") =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }), {
    headers: { "content-type": "application/json" },
  });
async function used(scope: string, metric: string): Promise<number> {
  const r = await env.DB.prepare("SELECT used FROM budgets WHERE day = ?1 AND scope = ?2 AND metric = ?3").bind(today(), scope, metric).first<{ used: number }>();
  return r?.used ?? 0;
}
async function setUsed(scope: string, metric: string, n: number, cap = 1_000_000) {
  await env.DB.prepare("INSERT INTO budgets (day, scope, metric, used, cap) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(day, scope, metric) DO UPDATE SET used = excluded.used")
    .bind(today(), scope, metric, n, cap)
    .run();
}

describe("Workers AI neuron pricing (Cloudflare pricing table)", () => {
  it("uses the published per-M-token rates and never under-counts unknown models", () => {
    expect(WORKERS_AI_NEURONS["@cf/meta/llama-3.2-1b-instruct"]).toEqual({ in: 2457, out: 18252 });
    expect(WORKERS_AI_NEURONS["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]).toEqual({ in: 26668, out: 204805 });
    // 1,000 in + 300 out on the 1B model = 2.457 + 5.4756 → 8 neurons
    expect(neuronsFor("workers-ai:@cf/meta/llama-3.2-1b-instruct", 1000, 300)).toBe(8);
    // same call on the 70B model costs ~10× more
    expect(neuronsFor("@cf/meta/llama-3.3-70b-instruct-fp8-fast", 1000, 300)).toBe(89);
    expect(neuronsFor("@cf/some/unknown-model", 1000, 300)).toBe(89);
    expect(neuronsFor("@cf/meta/llama-3.2-1b-instruct", 0, 0)).toBe(1);
  });

  it("caps: neurons = margin × 10,000; Gemini caps are per model and sum to the provider cap", () => {
    const c = deriveCaps({ margin: 0.7, geminiKeys: 1, workersAi: true });
    expect(c.neurons["workers-ai"]).toBe(Math.floor(FREE_TIER.workers_ai_neurons_day * 0.7));
    expect(c.model[GEMINI_FLASH]).toBe(Math.floor(GEMINI_FREE_RPD["gemini-3.5-flash"] * 0.7));
    expect(c.provider.gemini).toBe(Object.values(c.model).reduce((a, b) => a + b, 0));
    expect(deriveCaps({ margin: 0.7, workersAi: false }).neurons["workers-ai"]).toBe(0);
    expect(deriveCaps({ margin: 0.7, geminiKeys: 0 }).provider.gemini).toBe(0);
  });
});

describe("router: neuron-aware Workers AI budget", () => {
  it("reserves the worst case, then settles the ledger to the actual neuron cost", async () => {
    const r = new ModelRouter(waEnv(), { agentId: "lab:validate", providers: { "workers-ai": fakeWorkersAi(1000, 300) } });
    const res = await r.complete(req(512), { primary: WORKERS_AI_SMALL[0], fallbacks: [], temperature: 0.9 }, { pinned: true });
    expect(res.provider).toBe("workers-ai");
    expect(await used("provider:workers-ai", "neurons")).toBe(8);
    expect(await used("provider:workers-ai", "llm_calls")).toBe(1);
  });

  it("small models keep running long after 140 calls (the old flat cap)", async () => {
    const calls: string[] = [];
    const r = () => new ModelRouter(waEnv(), { agentId: "lab:validate", providers: { "workers-ai": fakeWorkersAi(400, 60, calls) } });
    for (let i = 0; i < 160; i++) await r().complete(req(64), { primary: WORKERS_AI_SMALL[0], fallbacks: [], temperature: 0.9 }, { pinned: true });
    expect(calls.length).toBe(160);
    expect(await used("provider:workers-ai", "neurons")).toBe(160 * neuronsFor(WORKERS_AI_SMALL[0], 400, 60)); // 3 neurons per call
  });

  it("skips a model whose worst-case cost no longer fits, still serving cheaper ones; all skipped → daily budget stop", async () => {
    const cap = (await new Governor(waEnv()).caps()).neurons["workers-ai"];
    await setUsed("provider:workers-ai", "neurons", cap - 5, cap);
    const calls: string[] = [];
    const r = new ModelRouter(waEnv({ GEMINI_KEY: undefined }), { agentId: "lab:validate", providers: { "workers-ai": fakeWorkersAi(10, 5, calls) } });
    // 70B with 1,024 max tokens needs ~210 neurons → skipped; 1B with 64 tokens needs ~2 → served
    const res = await r.complete(req(64), { primary: WORKERS_AI_STRONG, fallbacks: [WORKERS_AI_SMALL[0]], temperature: 0.2 }, { pinned: true });
    expect(res.model).toBe(WORKERS_AI_SMALL[0]);
    expect(r.attempts[0]).toMatchObject({ model: WORKERS_AI_STRONG, status: "skipped", detail: `${CAP_SKIP} (neurons)` });

    await setUsed("provider:workers-ai", "neurons", cap, cap);
    const r2 = new ModelRouter(waEnv({ GEMINI_KEY: undefined }), { agentId: "lab:validate", providers: { "workers-ai": fakeWorkersAi(10, 5, calls) } });
    await expect(r2.complete(req(64), { primary: WORKERS_AI_SMALL[0], fallbacks: [], temperature: 0.9 }, { pinned: true })).rejects.toBeInstanceOf(GovernorError);
    expect(calls.length).toBe(1);
  });

  it("refunds the call and the reservation (keeping only the prompt cost) when a Workers AI call fails", async () => {
    const failing: Provider = { name: "workers-ai", needsKey: false, call: async () => Promise.reject(new Error("boom")) };
    const r = new ModelRouter(waEnv({ GEMINI_KEY: undefined }), { agentId: "lab:validate", providers: { "workers-ai": failing } });
    await expect(r.complete(req(512), { primary: WORKERS_AI_SMALL[0], fallbacks: [], temperature: 0.9 }, { pinned: true })).rejects.toThrow();
    expect(await used("provider:workers-ai", "llm_calls")).toBe(0);
    expect(await used("provider:workers-ai", "neurons")).toBe(1);
  });
});

describe("router: Gemini per-model caps, cooldowns and thinking", () => {
  it("a Gemini model at its own daily cap is skipped while another Gemini model still serves", async () => {
    const caps = await new Governor(waEnv()).caps();
    await setUsed(`model:${GEMINI_FLASH}`, "llm_calls", caps.model[GEMINI_FLASH]);
    const urls: string[] = [];
    const r = new ModelRouter(waEnv(), { agentId: "lab:validate", fetcher: async (u) => (urls.push(String(u)), geminiOk()) });
    const res = await r.complete(req(), { primary: GEMINI_FLASH, fallbacks: [GEMINI_LITE], temperature: 0.2 }, { pinned: true });
    expect(res.model).toBe(GEMINI_LITE);
    expect(r.attempts[0]).toMatchObject({ model: GEMINI_FLASH, status: "skipped", detail: `${CAP_SKIP} (model)` });
    expect(urls.every((u) => !u.includes("gemini-3.5-flash"))).toBe(true);
    expect(await used(`model:${GEMINI_LITE}`, "llm_calls")).toBe(1);
  });

  it("a 429 on one Gemini model parks only that model, not the key for every Gemini model", async () => {
    let n = 0;
    const r = new ModelRouter(waEnv(), {
      fetcher: async (u) => (n++, String(u).includes("gemini-3.5-flash:") ? new Response("quota", { status: 429, headers: { "retry-after": "60" } }) : geminiOk()),
    });
    const res = await r.complete(req(), { primary: GEMINI_FLASH, fallbacks: [GEMINI_LITE], temperature: 0.2 }, { pinned: true });
    expect(res.model).toBe(GEMINI_LITE);
    const r2 = new ModelRouter(waEnv(), { fetcher: async () => (n++, geminiOk()) });
    const res2 = await r2.complete(req(), { primary: GEMINI_FLASH, fallbacks: [GEMINI_LITE], temperature: 0.2 }, { pinned: true });
    expect(res2.model).toBe(GEMINI_LITE); // flash still cooling down, lite is not
    expect(r2.attempts[0]).toMatchObject({ model: GEMINI_FLASH, status: "skipped", detail: "key cooling down" });
  });

  it("thinking Flash models get thinkingLevel low + headroom; Flash-Lite gets neither; empty answers name the finish reason", async () => {
    const bodies: Record<string, any> = {};
    const fetcher = async (u: RequestInfo | URL, init?: RequestInit) => {
      bodies[String(u).includes("lite") ? "lite" : "flash"] = JSON.parse(String(init?.body));
      return geminiOk();
    };
    await new ModelRouter(waEnv(), { fetcher }).complete(req(100), { primary: GEMINI_FLASH, fallbacks: [], temperature: 0.2 }, { only: true });
    await new ModelRouter(waEnv(), { fetcher }).complete(req(100), { primary: GEMINI_LITE, fallbacks: [], temperature: 0.2 }, { only: true });
    expect(bodies.flash.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(bodies.flash.generationConfig.maxOutputTokens).toBe(100 + GEMINI_THINKING_HEADROOM);
    expect(bodies.lite.generationConfig.thinkingConfig).toBeUndefined();
    expect(bodies.lite.generationConfig.maxOutputTokens).toBe(100);

    const empty = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }), { headers: { "content-type": "application/json" } });
    const r = new ModelRouter(waEnv(), { fetcher: empty });
    await expect(r.complete(req(), { primary: GEMINI_LITE, fallbacks: [], temperature: 0.2 }, { only: true })).rejects.toThrow();
    expect(r.attempts[0].detail).toContain("MAX_TOKENS");
  });
});

describe("judge panel: Gemini first, two distinct models, budget-aware", () => {
  it("with Gemini + Workers AI configured the panel is two different Gemini models (Workers AI neurons stay free)", () => {
    const lab = new LabLLM(waEnv(), { maxCalls: 10, share: 0.3 });
    for (const day of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
      const j = lab.judgeModels(2, day);
      expect(j).toHaveLength(2);
      expect(new Set(j).size).toBe(2);
      expect(j.every((m) => m.startsWith("gemini:"))).toBe(true);
    }
  });

  it("without Gemini the panel is still two distinct real models (e.g. two Workers AI models)", () => {
    const lab = new LabLLM(waEnv({ GEMINI_KEY: undefined }), { maxCalls: 10, share: 0.3 });
    const j = lab.judgeModels(2, "2026-10-12");
    expect(new Set(j).size).toBe(2);
    expect(j.every((m) => m.startsWith("workers-ai:"))).toBe(true);
  });

  it("judgeModelsLive skips a judge whose daily budget is used up and keeps two distinct models", async () => {
    const e = waEnv();
    const lab = new LabLLM(e, { maxCalls: 10, share: 0.3 });
    const day = "2026-10-12";
    const first = lab.judgeModels(2, day);
    const caps = await new Governor(e).caps();
    await setUsed(`model:${first[0]}`, "llm_calls", caps.model[first[0]]);
    const live = await lab.judgeModelsLive(2, day);
    expect(live).toHaveLength(2);
    expect(new Set(live).size).toBe(2);
    expect(live).not.toContain(first[0]);
  });
});

describe("transient Gemini overload (503 high demand)", () => {
  it("the router retries the same model once before moving on", async () => {
    let n = 0;
    const r = new ModelRouter(waEnv(), {
      transientDelayMs: 0,
      fetcher: async () => (++n === 1 ? new Response('{"error":{"code":503,"message":"high demand"}}', { status: 503 }) : geminiOk("second try")),
    });
    const res = await r.complete(req(), { primary: GEMINI_LITE, fallbacks: [], temperature: 0.2 }, { only: true });
    expect(res.text).toBe("second try");
    expect(n).toBe(2);
  });

  it("a judge slot whose model keeps failing is re-staffed with a model not already on the panel", async () => {
    const e = waEnv();
    const lab = new LabLLM(e, { maxCalls: 50, share: 1 });
    const day = new Date().toISOString().slice(0, 10);
    const panel = lab.judgeModels(2, day);
    const broken = panel[0].slice("gemini:".length);
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u: RequestInfo | URL) => {
      const url = String(u);
      seen.push(url);
      if (url.includes(`/${broken}:`)) return new Response('{"error":{"code":503}}', { status: 503 });
      return geminiOk(JSON.stringify({ scores: { year: 1, river: 1 }, flags: [] }));
    });
    const item: JudgeItem = {
      task: "Summarise the city.",
      inputs: {},
      checker: { type: "rubric", criteria: [{ id: "year", desc: "States 1412." }, { id: "river", desc: "Names the Avel." }], pass_threshold: 0.7 },
    };
    const v = await judge(item, "Founded in 1412 on the Avel, a quiet river town.", lab);
    const models = v.verdicts.map((x) => x.model);
    expect(models).toHaveLength(2);
    expect(new Set(models).size).toBe(2);
    expect(models).not.toContain(panel[0]);
    expect(models).toContain(panel[1]);
    expect(v.pass).toBe(true);
  }, 20_000);
});

describe("Gemini per-minute pacing and quota-aware 429s", () => {
  it("paces each model under its free RPM: the 16th Flash-Lite call in a minute moves on to the next model", async () => {
    const hits: string[] = [];
    const fetcher = async (u: RequestInfo | URL) => (hits.push(String(u)), geminiOk());
    for (let i = 0; i < 15; i++) await new ModelRouter(waEnv(), { fetcher }).complete(req(), { primary: GEMINI_LITE, fallbacks: [GEMINI_FLASH], temperature: 0.5 }, { pinned: true });
    const r = new ModelRouter(waEnv(), { fetcher });
    const res = await r.complete(req(), { primary: GEMINI_LITE, fallbacks: [GEMINI_FLASH], temperature: 0.5 }, { pinned: true });
    expect(res.model).toBe(GEMINI_FLASH);
    expect(r.attempts[0]).toMatchObject({ model: GEMINI_LITE, status: "skipped", detail: "key cooling down (rpm)" });
    expect(hits.filter((h) => h.includes("flash-lite")).length).toBe(15);
  });

  it("a per-DAY 429 names the quota and parks only that model for an hour", async () => {
    const body = {
      error: {
        code: 429,
        message: "You exceeded your current quota",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
        ],
      },
    };
    let t = 1_000_000;
    const fetcher = async (u: RequestInfo | URL) => (String(u).includes("gemini-3.5-flash:") ? new Response(JSON.stringify(body), { status: 429 }) : geminiOk());
    const r = new ModelRouter(waEnv(), { fetcher, now: () => t });
    await r.complete(req(), { primary: GEMINI_FLASH, fallbacks: [GEMINI_LITE], temperature: 0.5 }, { pinned: true });
    expect(r.attempts[0].status).toBe("rate_limited");
    expect(r.attempts[0].detail).toContain("GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20");
    t += 30 * 60_000; // 30 min later: still parked (a minute quota would be back after 41 s)
    const r2 = new ModelRouter(waEnv(), { fetcher, now: () => t });
    const res2 = await r2.complete(req(), { primary: GEMINI_FLASH, fallbacks: [GEMINI_LITE], temperature: 0.5 }, { pinned: true });
    expect(res2.model).toBe(GEMINI_LITE);
    expect(r2.attempts[0].detail).toBe("key cooling down");
  });
});

describe("daily lab ledger counts provider calls only", () => {
  it("a D1 cache hit gives the call back to the daily lab ledger and the job budget", async () => {
    const lab = new LabLLM(env as Env, { maxCalls: 10, share: 1 }); // mock mode
    const r0 = { messages: [{ role: "user" as const, content: "TASK: cache me\nPHASE: plan" }], temperature: 0 };
    await lab.complete("lab:test", r0);
    const again = await lab.complete("lab:test", r0);
    expect(again.cached).toBe(true);
    expect(lab.calls).toBe(1); // a cache hit costs nothing: not counted against the tick/job budget either
    expect(lab.cachedHits).toBe(1);
    expect(await used("lab", "llm_calls")).toBe(1);
  });
});
