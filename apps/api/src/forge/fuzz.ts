/**
 * Deterministic schema fuzzing: generate inputs that are VALID for a JSON schema (draft-07 subset used by
 * the eval factory) but sit on the edges: empty strings, max lengths, unicode, bounds, empty/long arrays,
 * optional properties missing. Seeded, so the same spec always gets the same hidden tests.
 */
import { schemaErrors } from "../eval/checkers";
import type { JsonSchema } from "../eval/types";
import { canonicalJson } from "../util";

export function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const EDGE_STRINGS = ["", " ", "a", "0", "-1", "null", "undefined", "__proto__", "constructor", "ﷺ مرحبا", "😀👍🏽", "\u0000\n\t", "<script>", "a".repeat(64)];

type Rng = () => number;
const pick = <T>(r: Rng, xs: T[]): T => xs[Math.floor(r() * xs.length)];

function genString(s: JsonSchema, r: Rng, mode: number): string {
  const min = s.minLength ?? 0;
  const max = Math.min(s.maxLength ?? 256, 2048);
  let v: string;
  if (mode === 0) v = "a".repeat(min);
  else if (mode === 1) v = "z".repeat(Math.max(min, Math.min(max, 256)));
  else if (r() < 0.6) v = pick(r, EDGE_STRINGS);
  else v = Array.from({ length: Math.floor(r() * 24) }, () => String.fromCharCode(32 + Math.floor(r() * 0x24f))).join("");
  if (v.length < min) v = v + "x".repeat(min - v.length);
  if (v.length > max) v = v.slice(0, max);
  return v;
}

function genNumber(s: JsonSchema, r: Rng, mode: number, integer: boolean): number {
  const lo = s.minimum ?? (integer ? -1_000_000_000 : -1e12);
  const hi = s.maximum ?? (integer ? 1_000_000_000 : 1e12);
  const cands = [lo, hi, 0, 1, -1, 2, 0.5, -0.5, 1e-9, 999_999, Math.floor(r() * 1000)].filter((x) => x >= lo && x <= hi);
  let v = mode === 0 ? lo : mode === 1 ? hi : cands.length ? pick(r, cands) : lo + r() * (hi - lo);
  if (integer) v = Math.max(Math.ceil(lo), Math.min(Math.floor(hi), Math.round(v)));
  return v;
}

/** Generate one value for `s`. mode 0 = minimal edge, 1 = maximal edge, ≥2 = random edge mix. */
export function genValue(s: JsonSchema, r: Rng, mode: number, depth = 0): unknown {
  if (s.const !== undefined) return s.const;
  if (s.enum && s.enum.length) return mode === 0 ? s.enum[0] : mode === 1 ? s.enum[s.enum.length - 1] : pick(r, s.enum);
  switch (s.type) {
    case "string":
      return genString(s, r, mode);
    case "integer":
      return genNumber(s, r, mode, true);
    case "number":
      return genNumber(s, r, mode, false);
    case "boolean":
      return mode === 0 ? false : mode === 1 ? true : r() < 0.5;
    case "null":
      return null;
    case "array": {
      const min = s.minItems ?? 0;
      const max = Math.min(s.maxItems ?? 16, depth > 2 ? 3 : 24);
      const n = mode === 0 ? min : mode === 1 ? Math.max(min, max) : min + Math.floor(r() * (Math.max(min, max) - min + 1));
      return Array.from({ length: n }, () => genValue(s.items ?? {}, r, mode >= 2 ? mode : mode, depth + 1));
    }
    case "object":
    default: {
      if (s.type === undefined && !s.properties) return pick(r, [0, "", null, true, [], {}]);
      const o: Record<string, unknown> = {};
      const req = new Set(s.required ?? []);
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        const include = req.has(k) || mode === 1 || (mode >= 2 && r() < 0.5);
        if (include) o[k] = genValue(sub, r, mode, depth + 1);
      }
      return o;
    }
  }
}

/** `n` distinct schema-valid edge inputs, deterministic for (schema, seed). */
export function fuzzInputs(schema: JsonSchema, n: number, seed: number): unknown[] {
  const r = mulberry32(seed);
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (let i = 0; out.length < n && i < n * 6; i++) {
    const v = genValue(schema, r, i < 2 ? i : 2 + i);
    if (schemaErrors(v, schema).length) continue;
    const key = canonicalJson(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
