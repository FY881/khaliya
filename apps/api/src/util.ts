const enc = new TextEncoder();

export function now(): number {
  return Date.now();
}

export function today(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function newId(prefix: string): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortDeep(val);
    }
    return out;
  }
  return v;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 15) + "…[truncated]";
}

export function safeJsonParse<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Extract the first JSON object from an LLM reply (handles ```json fences and chatter). */
export function extractJson<T = any>(text: string): T | null {
  const direct = safeJsonParse<T>(text.trim());
  if (direct !== null) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const f = safeJsonParse<T>(fence[1].trim());
    if (f !== null) return f;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return safeJsonParse<T>(text.slice(start, end + 1));
  return null;
}
