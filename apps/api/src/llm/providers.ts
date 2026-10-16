import { estimateTokens } from "../util";
import { mockAuthoredItem, mockLabBrain } from "../eval/mockBrain";
import { ProviderError, type LlmRequest, type LlmResponse, type Provider, type ProviderCall } from "./types";

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

async function fail(res: Response, who: string): Promise<never> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 300);
  } catch {}
  throw new ProviderError(`${who} HTTP ${res.status}: ${body}`, res.status, retryAfterMs(res));
}

// ---------------- Gemini (Google AI Studio free tier) ----------------
/**
 * Gemini 429 bodies carry google.rpc QuotaFailure (quotaId like "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
 * quotaValue) and RetryInfo (retryDelay "37s"). Surface them compactly so the router can park the model for the right
 * window and the job error says which limit was hit.
 */
async function geminiQuotaFail(res: Response): Promise<never> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {}
  let quotaId = "";
  let quotaValue = "";
  let retryMs = retryAfterMs(res);
  try {
    const details: any[] = JSON.parse(raw)?.error?.details ?? [];
    for (const d of details) {
      const v = d?.violations?.[0];
      if (v?.quotaId) {
        quotaId = String(v.quotaId);
        quotaValue = v.quotaValue != null ? String(v.quotaValue) : "";
      }
      const rd = typeof d?.retryDelay === "string" ? Number(d.retryDelay.replace(/s$/, "")) : NaN;
      if (Number.isFinite(rd)) retryMs = rd * 1000;
    }
  } catch {}
  const quota = /PerDay/i.test(quotaId) ? "day" : /PerMinute/i.test(quotaId) ? "minute" : undefined;
  const what = quotaId ? `quota ${quotaId}${quotaValue ? ` = ${quotaValue}` : ""}` : raw.slice(0, 200);
  throw new ProviderError(`gemini HTTP 429: ${what}${retryMs ? ` (retry in ${Math.round(retryMs / 1000)} s)` : ""}`, 429, retryMs, quota);
}

/** Extra output tokens a thinking Gemini model may spend on thoughts before the visible answer. */
export const GEMINI_THINKING_HEADROOM = 1024;
/** Gemini 3+/"latest" Flash models think by default; Flash-Lite and Gemma models do not. */
export const geminiThinks = (model: string) => /flash|pro/.test(model) && !/lite|gemma|tts|image/.test(model);
export const gemini: Provider = {
  name: "gemini",
  needsKey: true,
  async call({ model, req, key, fetcher }: ProviderCall): Promise<LlmResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    // Thinking models count their thoughts against maxOutputTokens: a short budget came back EMPTY (verified live
    // 2026-10-12 on gemini-flash-latest / 3.5-flash / 3.8-flash). Non-lite Flash models therefore get
    // thinkingLevel "low" (fast, verified) plus headroom; Flash-Lite models don't think by default and REJECT
    // thinkingBudget 0 / return empty with a forced level, so they get neither.
    const th = req.thinking ?? (geminiThinks(model) ? "low" : "model");
    const thinkingConfig = th === "off" ? { thinkingBudget: 0 } : th === "low" || th === "minimal" ? { thinkingLevel: th } : undefined;
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: (req.maxTokens ?? 1024) + (th === "off" || (th === "model" && !geminiThinks(model)) ? 0 : GEMINI_THINKING_HEADROOM),
        ...(req.json ? { responseMimeType: "application/json" } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key ?? "" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) await geminiQuotaFail(res);
    if (!res.ok) await fail(res, "gemini");
    const j: any = await res.json();
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
    if (!text) throw new ProviderError(`gemini: empty response${j?.candidates?.[0]?.finishReason ? ` (${j.candidates[0].finishReason})` : ""}`, 502);
    return {
      text,
      model: `gemini:${model}`,
      provider: "gemini",
      tokensIn: j?.usageMetadata?.promptTokenCount ?? estimateTokens(JSON.stringify(contents)),
      tokensOut: j?.usageMetadata?.candidatesTokenCount ?? estimateTokens(text),
    };
  },
};

// ---------------- OpenRouter (":free" models ONLY) ----------------
export const openrouter: Provider = {
  name: "openrouter",
  needsKey: true,
  async call({ model, req, key, fetcher }: ProviderCall): Promise<LlmResponse> {
    if (!model.endsWith(":free")) throw new ProviderError(`openrouter: refusing non-free model '${model}'`, 403);
    const res = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key ?? ""}`,
        "HTTP-Referer": "https://khaliya.local",
        "X-Title": "Khaliya",
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 1024,
      }),
    });
    if (!res.ok) await fail(res, "openrouter");
    const j: any = await res.json();
    if (j?.error) throw new ProviderError(`openrouter: ${j.error.message ?? "error"}`, j.error.code ?? 502);
    const text = j?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new ProviderError("openrouter: empty response", 502);
    return {
      text,
      model: `openrouter:${model}`,
      provider: "openrouter",
      tokensIn: j?.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(req.messages)),
      tokensOut: j?.usage?.completion_tokens ?? estimateTokens(text),
    };
  },
};

// ---------------- Workers AI (free daily neurons; binding, no key) ----------------
export function workersAi(ai: Ai | undefined): Provider {
  return {
    name: "workers-ai",
    needsKey: false,
    async call({ model, req }: ProviderCall): Promise<LlmResponse> {
      if (!ai) throw new ProviderError("workers-ai: AI binding missing", 503);
      let out: any;
      try {
        out = await (ai as any).run(model, {
          messages: req.messages,
          max_tokens: req.maxTokens ?? 1024,
          temperature: req.temperature ?? 0.3,
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        throw new ProviderError(`workers-ai: ${msg}`, /429|limit|neurons/i.test(msg) ? 429 : 502);
      }
      const c0 = out?.choices?.[0];
      const text =
        typeof out?.response === "string"
          ? out.response
          : typeof c0?.message?.content === "string"
            ? c0.message.content
            : typeof c0?.text === "string"
              ? c0.text
              : out?.response != null
                ? JSON.stringify(out.response)
                : "";
      if (!text) throw new ProviderError("workers-ai: empty response", 502);
      return {
        text,
        model: `workers-ai:${model}`,
        provider: "workers-ai",
        tokensIn: out?.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(req.messages)),
        tokensOut: out?.usage?.completion_tokens ?? estimateTokens(text),
      };
    },
  };
}

// ---------------- Mock (deterministic; tests + local dev without keys) ----------------
export type MockScript = (req: LlmRequest, model?: string) => string;

/**
 * Default deterministic agent brain. Reads the `PHASE:` marker the runtime puts in the prompt.
 *  - plan    → a fixed 3-step plan
 *  - act     → first: write a memory note (if memory.write is allowed), then: final answer
 *  - reflect → one lesson
 * Special task markers: "MOCK:loop" never finishes (for cap tests), "MOCK:approval" asks for http.get.
 */
export const defaultMockScript: MockScript = (req, model) => {
  // Studio service invocation (tests): «MOCK:service-say:<text>» → the service answers <text>; «MOCK:service-leak» → it
  // answers with its own system message (a prompt-leaking model), so the runtime output guard can be tested offline.
  const said = req.messages.map((m) => m.content).join("\n");
  const say = said.match(/MOCK:service-say:([^\n]*)/);
  if (say) return JSON.stringify({ answer: say[1] });
  if (said.includes("MOCK:service-leak")) return JSON.stringify({ answer: req.messages.find((m) => m.role === "system")?.content ?? "" });
  const lab = mockLabBrain(req, model ?? "default");
  if (lab !== null) return lab;
  const last = req.messages[req.messages.length - 1]?.content ?? "";
  const all = req.messages.map((m) => m.content).join("\n");
  const task = (all.match(/TASK:\s*(.*)/)?.[1] ?? "").trim();
  const phase = (last.match(/PHASE:\s*(\w+)/)?.[1] ?? "act").toLowerCase();
  const observations = (all.match(/OBSERVATION/g) ?? []).length;
  if (phase === "plan") return JSON.stringify({ plan: ["recall relevant memory", "record key facts", "answer the task"] });
  if (phase === "reflect")
    return JSON.stringify({ lessons: [`For tasks like "${task.slice(0, 60)}", note facts first, then answer.`], self_score: 0.8 });
  if (task.includes("MOCK:loop")) return JSON.stringify({ thought: "keep thinking", action: { tool: "think", args: { note: `step ${observations}` } } });
  if (task.includes("AUTHOR_EVAL_ITEMS") && /\beval\.author\b/.test(all)) {
    if (observations === 0) return JSON.stringify({ thought: "author a harder item", action: { tool: "eval.author", args: mockAuthoredItem(all) } });
    return JSON.stringify({ thought: "item submitted for validation", final: "Submitted a harder eval item for validation." });
  }
  if (task.includes("MOCK:approval") && observations === 0)
    return JSON.stringify({ thought: "need an external page", action: { tool: "http.get", args: { url: "https://example.com" } } });
  if (observations === 0 && /\bmemory\.write\b/.test(all))
    return JSON.stringify({ thought: "save the task for later", action: { tool: "memory.write", args: { text: `Task noted: ${task}`, kind: "note" } } });
  return JSON.stringify({ thought: "I have enough to answer", final: `Mock answer for: ${task}` });
};

export function mockProvider(script: MockScript = defaultMockScript): Provider {
  return {
    name: "mock",
    needsKey: false,
    async call({ model, req }: ProviderCall): Promise<LlmResponse> {
      const text = script(req, model);
      return {
        text,
        model: `mock:${model}`,
        provider: "mock",
        tokensIn: estimateTokens(req.messages.map((m) => m.content).join("\n")),
        tokensOut: estimateTokens(text),
      };
    },
  };
}
