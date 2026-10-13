import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { LlmRouterError, ModelRouter } from "../src/llm/router";
import { keyList } from "../src/llm/keys";
import { freshState } from "./helpers";

beforeEach(freshState);

const req = { messages: [{ role: "user" as const, content: "hi" }] };

function geminiOk(text = "hello") {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }), {
    headers: { "content-type": "application/json" },
  });
}
const tooMany = () => new Response("quota", { status: 429, headers: { "retry-after": "30" } });

function realEnv(over: Partial<Env> = {}): Env {
  return { ...(env as Env), LLM_MODE: "auto", GEMINI_KEY: "k1,k2", OPENROUTER_KEY: "or1", AI: undefined, ...over };
}

describe("model router", () => {
  it("parses comma / newline separated key lists", () => {
    expect(keyList(" a, b\nc ")).toEqual(["a", "b", "c"]);
    expect(keyList(undefined)).toEqual([]);
  });

  it("mock mode is deterministic and never touches the network", async () => {
    const r = new ModelRouter(env as Env, { fetcher: () => Promise.reject(new Error("network used")) });
    const a = await r.complete({ messages: [{ role: "user", content: "TASK: x\nPHASE: plan" }] });
    const b = await r.complete({ messages: [{ role: "user", content: "TASK: x\nPHASE: plan" }] });
    expect(a.provider).toBe("mock");
    expect(a.text).toBe(b.text);
  });

  it("rotates to the next key on 429, using the key header (never a URL param)", async () => {
    const seen: string[] = [];
    const r = new ModelRouter(realEnv(), {
      fetcher: async (url, init) => {
        expect(String(url)).not.toContain("key=");
        const key = (init?.headers as Record<string, string>)["x-goog-api-key"];
        seen.push(key);
        return key === "k1" ? tooMany() : geminiOk();
      },
    });
    const res = await r.complete(req, { primary: "gemini:gemini-flash-lite-latest", fallbacks: [], temperature: 0.3 });
    expect(res.provider).toBe("gemini");
    expect(res.keyIndex).toBe(1);
    expect(seen).toEqual(["k1", "k2"]);
    expect(r.attempts.map((a) => a.status)).toEqual(["rate_limited", "ok"]);
  });

  it("a rate-limited key cools down and is skipped on the next call", async () => {
    const seen: string[] = [];
    const fetcher = async (_u: any, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)["x-goog-api-key"];
      seen.push(key);
      return key === "k1" ? tooMany() : geminiOk();
    };
    const policy = { primary: "gemini:gemini-flash-lite-latest", fallbacks: [], temperature: 0.3 };
    await new ModelRouter(realEnv(), { fetcher }).complete(req, policy);
    seen.length = 0;
    const r2 = new ModelRouter(realEnv(), { fetcher });
    await r2.complete(req, policy);
    expect(seen).toEqual(["k2"]);
  });

  it("falls through to OpenRouter :free when all Gemini keys are limited", async () => {
    const r = new ModelRouter(realEnv(), {
      fetcher: async (url, init) => {
        if (String(url).includes("generativelanguage")) return tooMany();
        const body = JSON.parse(String(init?.body));
        expect(body.model.endsWith(":free")).toBe(true);
        return new Response(JSON.stringify({ choices: [{ message: { content: "from openrouter" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      },
    });
    const res = await r.complete(req);
    expect(res.provider).toBe("openrouter");
    expect(res.text).toBe("from openrouter");
  });

  it("never calls a paid OpenRouter model even if asked", async () => {
    let called = false;
    const r = new ModelRouter(realEnv({ GEMINI_KEY: "" }), {
      fetcher: async () => {
        called = true;
        return new Response("{}", { status: 500 });
      },
    });
    expect(r.chain({ primary: "openrouter:openai/gpt-4o", fallbacks: [], temperature: 0 })).not.toContain("openrouter:openai/gpt-4o");
    await expect(r.complete(req, { primary: "openrouter:openai/gpt-4o", fallbacks: [], temperature: 0.3 })).rejects.toBeInstanceOf(LlmRouterError);
    expect(called).toBe(true); // only the default :free models were tried
  });

  it("falls back to Workers AI binding when keyed providers fail", async () => {
    const fakeAi = { run: async () => ({ response: "from workers ai" }) } as unknown as Ai;
    const r = new ModelRouter(realEnv({ AI: fakeAi }), { fetcher: async () => tooMany() });
    const res = await r.complete(req);
    expect(res.provider).toBe("workers-ai");
  });

  it("uses mock when no provider is configured (local dev)", async () => {
    const r = new ModelRouter(realEnv({ GEMINI_KEY: "", OPENROUTER_KEY: "" }));
    expect(r.chain()).toEqual(["mock:default"]);
  });

  it("caches temperature-0 prompts in D1", async () => {
    let n = 0;
    const r = new ModelRouter(realEnv(), {
      fetcher: async () => {
        n++;
        return geminiOk("cached!");
      },
    });
    const p = { primary: "gemini:gemini-flash-lite-latest", fallbacks: [], temperature: 0 };
    await r.complete({ ...req, temperature: 0 }, p);
    const again = await r.complete({ ...req, temperature: 0 }, p);
    expect(n).toBe(1);
    expect(again.cached).toBe(true);
  });

  it("debits provider + agent daily caps when bound to an agent", async () => {
    const r = new ModelRouter(realEnv(), { agentId: "a_x", fetcher: async () => geminiOk() });
    await r.complete(req, { primary: "gemini:gemini-flash-lite-latest", fallbacks: [], temperature: 0.3 });
    const rows = (await env.DB.prepare("SELECT scope, metric, used FROM budgets").all<any>()).results;
    expect(rows.find((x: any) => x.scope === "provider:gemini")?.used).toBe(1);
    expect(rows.find((x: any) => x.scope === "agent:a_x" && x.metric === "llm_calls")?.used).toBe(1);
    expect(rows.find((x: any) => x.scope === "agent:a_x" && x.metric === "tokens")?.used).toBe(5);
  });
});

describe("router stall guards (pacing budget + per-call timeout)", () => {
  it("a hung provider call is aborted after callTimeoutMs and the chain moves on (no same-model retry)", async () => {
    let aborted = 0;
    let lite = 0;
    const r = new ModelRouter(realEnv({ GEMINI_KEY: "k1", OPENROUTER_KEY: undefined }), {
      callTimeoutMs: 60,
      transientDelayMs: 0,
      fetcher: (url, init) => {
        if (String(url).includes("flash-lite")) {
          lite++;
          return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => (aborted++, rej(new Error("aborted")))));
        }
        return Promise.resolve(geminiOk("from flash"));
      },
    });
    const t0 = Date.now();
    const res = await r.complete(req, { primary: "gemini:gemini-flash-lite-latest", fallbacks: ["gemini:gemini-flash-latest"], temperature: 0.5 }, { pinned: true });
    expect(res.text).toBe("from flash");
    expect(lite).toBe(1);
    expect(aborted).toBe(1);
    expect(r.attempts[0]).toMatchObject({ status: "error", detail: expect.stringMatching(/timeout/) });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("pacing sleeps share one budget per request: with no budget left a saturated model is skipped at once", async () => {
    const fetcher = async () => geminiOk();
    const policy = { primary: "gemini:gemini-flash-lite-latest", fallbacks: ["gemini:gemini-flash-latest"], temperature: 0.5 };
    const e = realEnv({ GEMINI_KEY: "k1", OPENROUTER_KEY: undefined });
    for (let i = 0; i < 15; i++) await new ModelRouter(e, { fetcher }).complete(req, policy, { pinned: true });
    const r = new ModelRouter(e, { fetcher, paceBudgetMs: 0 });
    const t0 = Date.now();
    const res = await r.complete(req, policy, { pinned: true });
    expect(res.model).toBe("gemini:gemini-flash-latest");
    expect(r.pacedMs).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
