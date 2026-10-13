/** Small, dependency-free text utilities shared by the eval factory and the evolution loop. */

/** 32-bit FNV-1a (sync, deterministic). Used for seeds and jitter, never for security. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number | string): () => number {
  let a = typeof seed === "number" ? seed >>> 0 : fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}
export function shuffle<T>(r: () => number, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Lowercase, Unicode-normalise, collapse whitespace, strip punctuation noise. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\u064b-\u065f]/g, "") // zero-width + Arabic diacritics
    .replace(/[^\p{L}\p{N}.\-+*/%=<>()[\]{}:,]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Character n-gram shingles over normalised text. */
export function shingles(s: string, n = 3): Set<string> {
  const t = normalizeText(s);
  const out = new Set<string>();
  if (t.length <= n) {
    if (t) out.add(t);
    return out;
  }
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const similarity = (a: string, b: string, n = 3) => jaccard(shingles(a, n), shingles(b, n));

export function words(s: string): string[] {
  return normalizeText(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}
