/**
 * Owner-only LLM diagnostics, mounted at /api/llm by index.ts (behind the owner gate).
 *   GET /api/llm/ping?model=gemini:gemini-flash-latest   one real 1-line call through the router, pinned to that
 *       model (no fallback). Answers {ok, model, provider, latency_ms, tokens, text|error, attempts}. Debited through
 *       the Governor like any call (agent "owner:diag"), so it can never bypass a daily cap.
 *   GET /api/llm/models?provider=gemini                 model ids the configured key can call (generateContent).
 * Keys never leave the Worker: error text is scrubbed of every configured key before it is returned.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { Governor } from "../governor/governor";
import { keyList } from "./keys";
import { DEFAULT_CHAIN, ModelRouter, WORKERS_AI_SMALL } from "./router";

type R = { Bindings: Env };
export const llmRoutes = new Hono<R>();

const DIAG_AGENT = "owner:diag";

function scrub(env: Env, s: string): string {
  let out = s;
  for (const k of [...keyList(env.GEMINI_KEY), ...keyList(env.OPENROUTER_KEY)]) if (k.length >= 8) out = out.split(k).join("[key]");
  return out.replace(/AIza[0-9A-Za-z_\-]{20,}/g, "[key]").replace(/sk-or-[0-9A-Za-z_\-]{10,}/g, "[key]");
}

llmRoutes.get("/ping", async (c) => {
  const model = c.req.query("model") || DEFAULT_CHAIN[0];
  const th = c.req.query("thinking");
  const thinking = th === "off" || th === "low" || th === "minimal" || th === "model" ? th : undefined;
  const maxTokens = Math.min(Math.max(Number(c.req.query("max_tokens")) || 16, 8), 2048);
  const router = new ModelRouter(c.env, { agentId: DIAG_AGENT });
  const t0 = Date.now();
  try {
    const res = await router.complete(
      { messages: [{ role: "user", content: "Reply with exactly the word: pong" }], temperature: 0.1, maxTokens, thinking },
      { primary: model, fallbacks: [], temperature: 0.1 },
      { only: true },
    );
    return c.json({
      ok: true,
      model: res.model,
      provider: res.provider,
      latency_ms: Date.now() - t0,
      tokens: { in: res.tokensIn, out: res.tokensOut },
      text: res.text.slice(0, 40),
      attempts: router.attempts.map((a) => ({ ...a, detail: a.detail ? scrub(c.env, a.detail) : undefined })),
    });
  } catch (e) {
    return c.json(
      {
        ok: false,
        model,
        latency_ms: Date.now() - t0,
        error: scrub(c.env, String((e as Error)?.message ?? e)).slice(0, 300),
        attempts: router.attempts.map((a) => ({ ...a, detail: a.detail ? scrub(c.env, a.detail) : undefined })),
      },
      200,
    );
  }
});

llmRoutes.get("/models", async (c) => {
  const provider = c.req.query("provider") || "gemini";
  if (provider === "workers-ai") return c.json({ provider, configured: !!c.env.AI, models: [...DEFAULT_CHAIN.filter((m) => m.startsWith("workers-ai:")), ...WORKERS_AI_SMALL] });
  if (provider !== "gemini") return c.json({ error: "provider must be gemini or workers-ai" }, 400);
  const key = keyList(c.env.GEMINI_KEY)[0];
  if (!key) return c.json({ provider, configured: false, models: [] });
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
  if (!r.ok) return c.json({ provider, ok: false, status: r.status, error: scrub(c.env, (await r.text()).slice(0, 300)) }, 200);
  const j: any = await r.json();
  const models = (j?.models ?? [])
    .filter((m: any) => (m?.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m: any) => String(m.name).replace(/^models\//, ""));
  return c.json({ provider, ok: true, count: models.length, models });
});

/** Today's Workers AI neuron + per-provider/per-model usage vs caps (no secrets). */
llmRoutes.get("/budget", async (c) => {
  const gov = new Governor(c.env);
  const caps = await gov.caps();
  const usage = (await gov.usage()).filter((u) => u.scope.startsWith("provider:") || u.scope.startsWith("model:") || u.scope === "lab");
  return c.json({ caps: { provider: caps.provider, model: caps.model, neurons: caps.neurons, margin: caps.margin }, usage });
});
