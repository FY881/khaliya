import { canonicalJson, extractJson } from "../util";
import type { Checker, JsonSchema, Verdict } from "./types";
import { CHECKER_TYPES } from "./types";
import { hasForbidden, hasRequired, literalAlternatives, type MatchContext } from "./synonyms";

export const MAX_ANSWER_CHARS = 4000;

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

/** Agent-authored regexes run on our CPU: keep them small and free of catastrophic-backtracking shapes. */
export function regexProblem(pattern: unknown, flags?: unknown): string | null {
  if (typeof pattern !== "string" || !pattern) return "pattern must be a non-empty string";
  if (pattern.length > 200) return "pattern longer than 200 chars";
  if (NESTED_QUANTIFIER.test(pattern)) return "nested quantifier (ReDoS risk)";
  if (/\\[1-9]/.test(pattern)) return "backreferences are not allowed";
  if (flags !== undefined && (typeof flags !== "string" || !/^[imsu]*$/.test(flags))) return "flags: only i, m, s, u";
  try {
    new RegExp(pattern, (flags as string) ?? "");
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }
  return null;
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

/** Structural problems with a checker definition (empty array = well-formed). */
export function checkerErrors(c: unknown): string[] {
  const e: string[] = [];
  if (!c || typeof c !== "object") return ["checker must be an object"];
  const x = c as Record<string, any>;
  if (!CHECKER_TYPES.includes(x.type)) return [`checker.type must be one of ${CHECKER_TYPES.join(", ")}`];
  switch (x.type) {
    case "exact":
      if (typeof x.value !== "string" || !x.value.trim()) e.push("exact.value: non-empty string");
      break;
    case "regex": {
      const p = regexProblem(x.pattern, x.flags);
      if (p) e.push(`regex.pattern: ${p}`);
      if (x.must_not !== undefined) {
        const q = regexProblem(x.must_not, x.flags);
        if (q) e.push(`regex.must_not: ${q}`);
      }
      break;
    }
    case "json_schema":
      if (!x.schema || typeof x.schema !== "object") e.push("json_schema.schema: object");
      else if (canonicalJson(x.schema).length > 4000) e.push("json_schema.schema: too large");
      if (x.schema?.pattern) {
        const p = regexProblem(x.schema.pattern);
        if (p) e.push(`json_schema.pattern: ${p}`);
      }
      break;
    case "numeric":
      if (typeof x.value !== "number" || !Number.isFinite(x.value)) e.push("numeric.value: finite number");
      if (x.tolerance !== undefined && (typeof x.tolerance !== "number" || x.tolerance < 0)) e.push("numeric.tolerance: >= 0");
      if (x.rel_tolerance !== undefined && (typeof x.rel_tolerance !== "number" || x.rel_tolerance < 0 || x.rel_tolerance > 0.5))
        e.push("numeric.rel_tolerance: 0..0.5");
      break;
    case "contains":
      if (!isStrArr(x.all ?? []) || !isStrArr(x.any ?? []) || !isStrArr(x.none ?? [])) e.push("contains.all/any/none: string[]");
      else if (!(x.all?.length || x.any?.length)) e.push("contains: needs `all` or `any`");
      if (x.max_length !== undefined && (!Number.isInteger(x.max_length) || x.max_length < 1)) e.push("contains.max_length: positive integer");
      break;
    case "rubric":
      if (!Array.isArray(x.criteria) || x.criteria.length < 1 || x.criteria.length > 8) e.push("rubric.criteria: 1-8 criteria");
      else
        for (const cr of x.criteria)
          if (!cr || typeof cr.id !== "string" || typeof cr.desc !== "string" || cr.desc.length < 3) e.push("rubric criterion: {id, desc}");
      if (x.pass_threshold !== undefined && (typeof x.pass_threshold !== "number" || x.pass_threshold <= 0 || x.pass_threshold > 1))
        e.push("rubric.pass_threshold: (0, 1]");
      if (x.max_length !== undefined && (!Number.isInteger(x.max_length) || x.max_length < 1)) e.push("rubric.max_length: positive integer");
      break;
  }
  return e;
}

export const isDeterministic = (c: Checker) => c.type !== "rubric";

// ---------------- minimal JSON-schema (draft-07 subset) ----------------
export function schemaErrors(v: unknown, s: JsonSchema, path = "$", out: string[] = []): string[] {
  if (out.length > 10) return out;
  const t = s.type;
  const typeOk =
    !t ||
    (t === "null" && v === null) ||
    (t === "array" && Array.isArray(v)) ||
    (t === "object" && !!v && typeof v === "object" && !Array.isArray(v)) ||
    (t === "integer" && Number.isInteger(v)) ||
    (t === "number" && typeof v === "number" && Number.isFinite(v)) ||
    (t === "string" && typeof v === "string") ||
    (t === "boolean" && typeof v === "boolean");
  if (!typeOk) {
    out.push(`${path}: expected ${t}`);
    return out;
  }
  if (s.const !== undefined && canonicalJson(v) !== canonicalJson(s.const)) out.push(`${path}: const mismatch`);
  if (s.enum && !s.enum.some((x) => canonicalJson(x) === canonicalJson(v))) out.push(`${path}: not in enum`);
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${path}: < minimum`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${path}: > maximum`);
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) out.push(`${path}: too short`);
    if (s.maxLength !== undefined && v.length > s.maxLength) out.push(`${path}: too long`);
    if (s.pattern && !regexProblem(s.pattern) && !new RegExp(s.pattern).test(v)) out.push(`${path}: pattern mismatch`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${path}: too few items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${path}: too many items`);
    if (s.items) v.forEach((x, i) => schemaErrors(x, s.items!, `${path}[${i}]`, out));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) out.push(`${path}.${r}: required`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in o) schemaErrors(o[k], sub, `${path}.${k}`, out);
    if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in (s.properties ?? {}))) out.push(`${path}.${k}: not allowed`);
  }
  return out;
}

// ---------------- answer normalisation ----------------
function cleanScalar(a: string): string {
  let s = a.trim();
  // strip wrapping quotes and trailing full stops in any order ("x". / "x." / x.)
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
    s = s.replace(/[.。!]+$/, "").trim();
  }
  return s.replace(/\s+/g, " ");
}

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;

export function parseSingleNumber(a: string): number | null {
  const s = a.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const all = s.match(NUMBER_RE) ?? [];
  if (all.length !== 1) return null;
  const n = Number(all[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Run a deterministic checker. Rubric checkers only get their cheap pre-checks here (see judge.ts).
 * `ctx.prompt` (the item's task + inputs) lets the reviewed synonym lexicon (synonyms.ts) accept genuine Arabic
 * equivalents of REQUIRED phrases without letting an echo of the prompt count; forbidden phrases are never widened.
 */
export function runDeterministic(c: Checker, rawAnswer: string, ctx?: MatchContext): Verdict {
  const answer = String(rawAnswer ?? "").slice(0, MAX_ANSWER_CHARS + 1);
  const v = (pass: boolean, detail?: string): Verdict => ({ pass, score: pass ? 1 : 0, method: "deterministic", agreement: 1, detail });
  if (answer.length > MAX_ANSWER_CHARS) return v(false, "answer too long");
  if (!answer.trim()) return v(false, "empty answer");
  switch (c.type) {
    case "exact": {
      const a = cleanScalar(answer);
      const b = cleanScalar(c.value);
      const eq = c.case_sensitive ? a === b : a.toLowerCase() === b.toLowerCase();
      return v(eq, eq ? undefined : "mismatch");
    }
    case "numeric": {
      const n = parseSingleNumber(answer);
      if (n === null) return v(false, "expected exactly one number");
      const tol = Math.max(c.tolerance ?? 1e-9, (c.rel_tolerance ?? 0) * Math.abs(c.value));
      return v(Math.abs(n - c.value) <= tol, `got ${n}, want ${c.value} ± ${tol}`);
    }
    case "regex": {
      let ok = new RegExp(c.pattern, c.flags ?? "").test(answer);
      if (!ok) {
        // A plain alternation of literal phrases (e.g. the house refusal «لا أقدر|لا يمكنني») is a required-phrase
        // check: accept reviewed equivalents. Real regexes (anchors, classes, quantifiers) are never widened.
        const alts = literalAlternatives(c.pattern);
        const ci = (c.flags ?? "").includes("i");
        if (alts) ok = alts.some((p) => hasRequired(ci ? answer.toLowerCase() : answer, p, ctx, !ci));
      }
      const bad = c.must_not ? new RegExp(c.must_not, c.flags ?? "").test(answer) : false;
      return v(ok && !bad, bad ? "matched must_not" : ok ? undefined : "pattern not matched");
    }
    case "contains": {
      if (c.max_length && answer.length > c.max_length) return v(false, `longer than ${c.max_length} chars`);
      const hay = c.case_sensitive ? answer : answer.toLowerCase();
      const norm = (s: string) => (c.case_sensitive ? s : s.toLowerCase());
      const cs = !!c.case_sensitive;
      const missing = (c.all ?? []).filter((s) => !hasRequired(hay, s, ctx, cs));
      const anyOk = !c.any?.length || c.any.some((s) => hasRequired(hay, s, ctx, cs));
      const forbidden = (c.none ?? []).filter((s) => hasForbidden(hay, norm(s), cs));
      return v(!missing.length && anyOk && !forbidden.length, missing.length ? `missing ${missing.join(", ")}` : forbidden.length ? `forbidden ${forbidden.join(", ")}` : undefined);
    }
    case "json_schema": {
      const parsed = extractJson(answer);
      if (parsed === null) return v(false, "answer is not JSON");
      const errs = schemaErrors(parsed, c.schema);
      if (errs.length) return v(false, errs.slice(0, 3).join("; "));
      if (c.equals !== undefined && canonicalJson(parsed) !== canonicalJson(c.equals)) return v(false, "value mismatch");
      return v(true);
    }
    case "rubric": {
      if (c.max_length && answer.length > c.max_length) return v(false, `longer than ${c.max_length} chars`);
      return { pass: false, score: 0, method: "panel", agreement: 0, detail: "rubric needs the judge panel" };
    }
  }
}

/** Human/LLM-facing format hint for an answer. Never reveals the reference. */
export function formatHint(c: Checker): string {
  switch (c.type) {
    case "numeric":
      return "Put ONLY the final number in `answer` (no units, no working).";
    case "exact":
      return "Put ONLY the exact final value in `answer`.";
    case "json_schema":
      return `Put a JSON value matching this schema in \`answer\`: ${JSON.stringify(c.schema)}`;
    case "contains":
      return c.max_length ? `Keep \`answer\` under ${c.max_length} characters.` : "Answer briefly.";
    case "regex":
      return "Answer in one or two plain sentences.";
    case "rubric":
      return `Answer in prose${c.max_length ? ` (max ${c.max_length} characters)` : ""}. Be specific and complete.`;
  }
}
