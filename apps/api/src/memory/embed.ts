/**
 * Embeddings (Workers AI @cf/baai/bge-m3, multilingual incl. Arabic, 1024 dims) + Vectorize, both FREE-plan.
 *
 * Free-plan facts this module budgets against (fetched 2026-10-12):
 *  - bge-m3 costs 1,075 neurons per 1M input tokens (https://developers.cloudflare.com/workers-ai/platform/pricing/);
 *    the 10k/day neuron allowance is shared with the LLM fallback, so every embed reserves neurons via the Governor.
 *  - Vectorize Workers Free: 5M stored dims and 30M queried dims/month
 *    (https://developers.cloudflare.com/vectorize/platform/pricing/). At 1024 dims that is ~4,880 stored vectors and
 *    ~29k queries/month, so we cap stored vectors at MAX_VECTORS and vector queries per day at VECTOR_QUERIES_DAY;
 *    beyond either cap search silently uses the D1 FTS5 keyword index only.
 *
 * Vectors are only used when LLM_MODE != "mock", KB_EMBED != "off", and BOTH the AI and KB_VECTORS bindings exist.
 * Otherwise (tests, local dev, no index created yet) everything works on FTS5 alone.
 */
import { Governor } from "../governor/governor";
import { estimateTokens } from "../util";
import type { MemoryEnv } from "./types";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIMS = 1024;
export const EMBED_NEURONS_PER_M = 1075;
export const MAX_VECTORS = 4000; // 80% of 5M / 1024
export const VECTOR_QUERIES_DAY = 500; // ≈ (0.7 × 30M / 1024 − MAX_VECTORS) / 31
const MAX_EMBED_CHARS = 2000; // bge-m3 takes long input, but keep the cost and the latency small

export function vectorsEnabled(env: MemoryEnv): boolean {
  return (env.LLM_MODE ?? "auto") !== "mock" && env.KB_EMBED !== "off" && !!env.AI && !!env.KB_VECTORS;
}

/** Vectorize namespaces are ≤ 64 bytes: 'org' or 'a:' + agent id (hashed when long). */
export function namespaceFor(scope: string): string {
  if (scope === "org") return "org";
  const id = scope.replace(/^agent:/, "");
  if (id.length <= 60) return `a:${id}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return `a:${id.slice(0, 48)}~${(h >>> 0).toString(16)}`;
}

/** Embed texts, or null when vectors are disabled / out of neuron budget / the call fails. Never throws. */
export async function embed(env: MemoryEnv, texts: string[]): Promise<number[][] | null> {
  if (!vectorsEnabled(env) || !texts.length) return null;
  const clipped = texts.map((t) => t.slice(0, MAX_EMBED_CHARS));
  const tok = clipped.reduce((s, t) => s + estimateTokens(t), 0);
  const neurons = Math.max(1, Math.ceil((tok * EMBED_NEURONS_PER_M) / 1_000_000));
  const gov = new Governor(env);
  if (!(await gov.reserveNeurons(neurons))) return null;
  try {
    const out = (await (env.AI as any).run(EMBED_MODEL, { text: clipped })) as { data?: number[][] };
    await gov.settleNeurons(neurons, neurons);
    const data = out?.data;
    if (!Array.isArray(data) || data.length !== clipped.length || data.some((v) => !Array.isArray(v) || v.length !== EMBED_DIMS)) return null;
    return data;
  } catch (e) {
    await gov.settleNeurons(neurons, 0);
    console.error("kb embed failed", String((e as Error)?.message ?? e).slice(0, 200));
    return null;
  }
}

/** Upsert one doc vector (returns false when disabled, over the stored-vector cap, or on error). */
export async function upsertVector(env: MemoryEnv, id: string, scope: string, text: string, meta: Record<string, string>, storedCount: number): Promise<boolean> {
  if (!vectorsEnabled(env) || storedCount >= MAX_VECTORS) return false;
  const v = await embed(env, [text]);
  if (!v) return false;
  try {
    await env.KB_VECTORS!.upsert([{ id, values: v[0], namespace: namespaceFor(scope), metadata: meta }]);
    return true;
  } catch (e) {
    console.error("kb vector upsert failed", String((e as Error)?.message ?? e).slice(0, 200));
    return false;
  }
}

export async function deleteVectors(env: MemoryEnv, ids: string[]): Promise<void> {
  if (!env.KB_VECTORS || !ids.length) return;
  try {
    await env.KB_VECTORS.deleteByIds(ids);
  } catch (e) {
    console.error("kb vector delete failed", String((e as Error)?.message ?? e).slice(0, 200));
  }
}

/** Vector search in one or more scopes. [] when disabled or over the daily query cap. */
export async function vectorQuery(env: MemoryEnv, q: string, scopes: string[], topK = 10): Promise<{ id: string; score: number }[]> {
  if (!vectorsEnabled(env)) return [];
  const gov = new Governor(env);
  if (!(await gov.debitOne("kb:vectorize", "queries", scopes.length, VECTOR_QUERIES_DAY))) return [];
  const v = await embed(env, [q]);
  if (!v) return [];
  const out: { id: string; score: number }[] = [];
  for (const s of scopes) {
    try {
      const r = await env.KB_VECTORS!.query(v[0], { topK: Math.min(20, topK), namespace: namespaceFor(s), returnMetadata: "none" });
      for (const m of r.matches ?? []) out.push({ id: m.id, score: m.score });
    } catch (e) {
      console.error("kb vector query failed", String((e as Error)?.message ?? e).slice(0, 200));
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
