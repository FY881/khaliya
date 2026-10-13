/**
 * Text utilities for the memory/KB layer: Arabic-aware normalisation (for the FTS5 keyword index and dedupe),
 * content hashing, character-shingle similarity (near-duplicate detection), and FTS5 query building.
 * Everything here is deterministic and dependency-free.
 */
import { sha256Hex } from "../util";

// Arabic diacritics (tashkeel), Quranic marks, tatweel.
const AR_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Fold text for indexing and comparison. Arabic: strip tashkeel + tatweel, unify alef forms (أ إ آ ٱ → ا),
 * ى → ي, ة → ه, ؤ → و, ئ → ي, Arabic-Indic digits → ASCII. Latin: NFKC + lowercase. Punctuation → space.
 */
export function foldText(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(AR_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const tokens = (s: string): string[] => foldText(s).split(" ").filter((t) => t.length > 1);

/** True when the text is mostly Arabic script. */
export function isArabic(s: string): boolean {
  const ar = (s.match(/[\u0600-\u06FF]/g) ?? []).length;
  const lat = (s.match(/[A-Za-z]/g) ?? []).length;
  return ar > 0 && ar >= lat;
}

/** Content hash used for exact dedupe: over the folded title+body so whitespace/diacritics changes collide. */
export async function contentHash(title: string, body: string): Promise<string> {
  return (await sha256Hex(`${foldText(title)}\n${foldText(body)}`)).slice(0, 32);
}

/** Character 4-gram shingles over folded text (works for Arabic, where word stems vary with clitics). */
export function shingles(s: string, n = 4): Set<string> {
  const t = foldText(s).replace(/ /g, "_");
  const out = new Set<string>();
  if (t.length <= n) {
    if (t) out.add(t);
    return out;
  }
  for (let i = 0; i + n <= t.length && out.size < 4000; i++) out.add(t.slice(i, i + n));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Near-duplicate similarity of two texts in [0, 1]. */
export const similarity = (a: string, b: string) => jaccard(shingles(a), shingles(b));

// Leading clitics + article, longest first (folded forms). Only stripped when ≥ 3 letters remain.
const AR_PREFIXES = ["وال", "بال", "كال", "فال", "لل", "ال"];

/** Light Arabic stem: drop a leading article/clitic cluster (الموافقه → موافقه, والوكلاء → وكلاء). Non-Arabic unchanged. */
export function arLightStem(t: string): string {
  if (!/[\u0600-\u06FF]/.test(t)) return t;
  for (const p of AR_PREFIXES) if (t.startsWith(p) && t.length - p.length >= 3) return t.slice(p.length);
  return t;
}

/** Folded text for the FTS index plus the light stems of its Arabic tokens, so "الموافقة" and "موافقة" meet. */
export function ftsIndexText(s: string): string {
  const f = foldText(s);
  const have = new Set(f.split(" "));
  const extra: string[] = [];
  for (const t of have) {
    const st = arLightStem(t);
    if (st !== t && !have.has(st) && !extra.includes(st)) extra.push(st);
  }
  return extra.length ? `${f} ${extra.join(" ")}` : f;
}

/**
 * Build a safe FTS5 MATCH expression: every folded token quoted (so user text can never inject FTS syntax),
 * OR-joined so partial matches still rank. Returns null when the query has no usable tokens.
 */
export function ftsQuery(q: string, maxTerms = 12): string | null {
  const base = [...new Set(tokens(q))].slice(0, maxTerms);
  const ts = [...new Set(base.flatMap((t) => [t, arLightStem(t)]))];
  if (!ts.length) return null;
  return ts.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** First `n` sentences (Arabic and Latin sentence enders). Used by the deterministic summariser. */
export function firstSentences(s: string, n = 1, max = 240): string {
  const parts = s
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?؟。])\s+/)
    .filter(Boolean);
  const out = parts.slice(0, n).join(" ");
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}
