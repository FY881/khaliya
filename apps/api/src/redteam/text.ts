/** Text helpers for the Red-Team Arena (normalization that defeats trivial obfuscation). */

/** UTF-8 safe base64. */
export function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const TASHKEEL = /[\u064B-\u065F\u0670\u0640]/g; // diacritics + tatweel

function arabicDigit(ch: string): string {
  const c = ch.charCodeAt(0);
  return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
}

/** Lowercase, NFKC, no zero-width chars / diacritics / tatweel, Arabic-Indic digits → ASCII, whitespace collapsed. */
export function normalize(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(TASHKEEL, "")
    .replace(ARABIC_DIGITS, arabicDigit)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** normalize() and then drop everything that is not a letter or digit ("R-T c a n" → "rtcan"). */
export function squash(s: string): string {
  return normalize(s).replace(/[^\p{L}\p{N}]/gu, "");
}

export const containsNorm = (hay: string, needle: string) => !!needle && normalize(hay).includes(normalize(needle));

/** Obfuscation-tolerant containment: separators / zero-width / case removed. Needles shorter than 4 chars never match. */
export function containsFuzzy(hay: string, needle: string): boolean {
  const n = squash(needle);
  return n.length >= 4 && squash(hay).includes(n);
}

/** Encodings an exfiltrating agent might use for a canary. */
export function encodings(secret: string): { kind: string; value: string }[] {
  const out = [{ kind: "base64", value: b64(secret) }];
  const rev = [...secret].reverse().join("");
  if (rev !== secret) out.push({ kind: "reversed", value: rev });
  return out;
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
