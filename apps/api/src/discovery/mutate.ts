/**
 * Program mutation operators for the Discovery Lab.
 *
 *  - tweak:     deterministic parameter tweak. Prefers "knobs" (`var NAME = number;` with an UPPERCASE name),
 *               otherwise any numeric literal. Integers move by ±1..3 (0/1 flags can flip), floats by a
 *               relative jitter. Pure function of (code, rng).
 *  - crossover: deterministic function swap: a top-level `function f(...) {...}` of parent A is replaced by
 *               parent B's version of f; when no function differs, knob values are taken from B.
 *  - llm:       a Researcher prompt (problem, parent program + score, top programs as inspiration) asking
 *               for a full program in a ```js block; extractProgram() pulls it out of the reply.
 */
import type { Rng } from "../evolution/bandit";
import type { ProblemDef } from "./types";

export const MAX_PROGRAM_BYTES = 16 * 1024;

const KNOB_RE = /\bvar\s+([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*;/g;
const NUM_RE = /(^|[^\w.$])(\d+(?:\.\d+)?)(?![\w.])/g;

export interface Knob {
  name: string;
  value: number;
  raw: string;
  /** Index of the numeric text in the code. */
  at: number;
}

export function findKnobs(code: string): Knob[] {
  const out: Knob[] = [];
  for (const m of code.matchAll(KNOB_RE)) {
    const numAt = (m.index ?? 0) + m[0].lastIndexOf(m[2]);
    out.push({ name: m[1], value: Number(m[2]), raw: m[2], at: numAt });
  }
  return out;
}

function fmt(v: number, integer: boolean): string {
  if (integer) return String(Math.round(v));
  const s = Number(v.toPrecision(6)).toString();
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}

export function tweakValue(value: number, raw: string, rng: Rng): number {
  const integer = !raw.includes(".") && !raw.includes("e");
  if (integer) {
    if ((value === 0 || value === 1) && rng() < 0.5) return 1 - value; // flag flip
    const mag = rng() < 0.7 ? 1 : 1 + Math.floor(rng() * 3);
    const v = value + (rng() < 0.5 ? -mag : mag);
    return v;
  }
  if (value === 0) return Number((rng() * 0.2).toPrecision(6));
  const v = rng() < 0.5 ? value * (1 + (rng() - 0.5) * 0.4) : value + (rng() - 0.5) * 0.1 * Math.max(1, Math.abs(value));
  return Number(v.toPrecision(6));
}

/** Parameter tweak. Returns null when the code has nothing to tweak. */
export function tweak(code: string, rng: Rng): { code: string; note: string } | null {
  const knobs = findKnobs(code);
  if (knobs.length && rng() < 0.9) {
    const k = knobs[Math.floor(rng() * knobs.length)];
    const nv = tweakValue(k.value, k.raw, rng);
    const integer = !k.raw.includes(".") && !k.raw.includes("e");
    const txt = fmt(nv, integer);
    return { code: code.slice(0, k.at) + txt + code.slice(k.at + k.raw.length), note: `${k.name}: ${k.raw} → ${txt}` };
  }
  const nums: { at: number; raw: string }[] = [];
  for (const m of code.matchAll(NUM_RE)) nums.push({ at: (m.index ?? 0) + m[1].length, raw: m[2] });
  if (!nums.length) return null;
  const n = nums[Math.floor(rng() * nums.length)];
  const integer = !n.raw.includes(".");
  const nv = tweakValue(Number(n.raw), n.raw, rng);
  if (nv < 0) return null; // keep bare literals non-negative (a leading '-' could change parsing)
  const txt = fmt(nv, integer);
  return { code: code.slice(0, n.at) + txt + code.slice(n.at + n.raw.length), note: `literal @${n.at}: ${n.raw} → ${txt}` };
}

export interface FnSpan {
  name: string;
  start: number;
  end: number; // exclusive
  text: string;
}

/** Top-level `function name(...) { ... }` declarations (brace matching that skips strings and comments). */
export function topLevelFunctions(code: string): FnSpan[] {
  const out: FnSpan[] = [];
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  for (const m of code.matchAll(re)) {
    const start = m.index ?? 0;
    const open = code.indexOf("{", start);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    let end = -1;
    while (i < code.length) {
      const c = code[i];
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        i++;
        while (i < code.length && code[i] !== q) i += code[i] === "\\" ? 2 : 1;
      } else if (c === "/" && code[i + 1] === "/") {
        while (i < code.length && code[i] !== "\n") i++;
      } else if (c === "/" && code[i + 1] === "*") {
        const e = code.indexOf("*/", i + 2);
        i = e < 0 ? code.length : e + 1;
      } else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
      i++;
    }
    if (end > 0) out.push({ name: m[1], start, end, text: code.slice(start, end) });
  }
  return out;
}

/** Function-swap crossover. Returns null when the parents share nothing to swap. */
export function crossover(a: string, b: string, rng: Rng): { code: string; note: string } | null {
  const fa = topLevelFunctions(a);
  const fb = new Map(topLevelFunctions(b).map((f) => [f.name, f]));
  const swappable = fa.filter((f) => fb.has(f.name) && fb.get(f.name)!.text !== f.text);
  if (swappable.length) {
    const f = swappable[Math.floor(rng() * swappable.length)];
    const g = fb.get(f.name)!;
    return { code: a.slice(0, f.start) + g.text + a.slice(f.end), note: `function ${f.name} from second parent` };
  }
  // knob crossover: take each shared knob from B with probability 1/2 (at least one)
  const ka = findKnobs(a);
  const kb = new Map(findKnobs(b).map((k) => [k.name, k]));
  const diff = ka.filter((k) => kb.has(k.name) && kb.get(k.name)!.raw !== k.raw);
  if (!diff.length) return null;
  const pick = diff.filter(() => rng() < 0.5);
  if (!pick.length) pick.push(diff[Math.floor(rng() * diff.length)]);
  let code = a;
  for (const k of [...pick].sort((x, y) => y.at - x.at)) code = code.slice(0, k.at) + kb.get(k.name)!.raw + code.slice(k.at + k.raw.length);
  return { code, note: `knobs ${pick.map((k) => k.name).join(", ")} from second parent` };
}

// ---------------- LLM mutation ----------------
export interface PromptProgram {
  code: string;
  score: number | null;
}

export function mutationPrompt(def: ProblemDef, parent: PromptProgram, inspirations: PromptProgram[], bestKnown?: number | null): { system: string; user: string } {
  const instance = JSON.stringify(def.instance);
  const inst = instance.length > 600 ? `${instance.slice(0, 600)}… (${instance.length} chars; the full instance is passed to construct as input)` : instance;
  const system =
    "You are a Researcher agent of the Khaliya Discovery Lab. You improve JavaScript programs that construct solutions to an open mathematical / optimisation problem. " +
    "A deterministic verifier scores every solution, so only real improvements count. Keep the code plain ES5-style JavaScript for a sandbox with no network, no imports, no timers; `rand()` is the only randomness (seeded). " +
    "The program must declare `function construct(input)` and return the solution. Stay well inside the compute budget (a few million simple operations). " +
    "Reply with ONE complete program in a single ```js code block and nothing else of substance.";
  const insp = inspirations
    .slice(0, 3)
    .map((p, i) => `INSPIRATION ${i + 1} (score ${p.score}):\n\`\`\`js\n${p.code.slice(0, 3000)}\n\`\`\``)
    .join("\n\n");
  const user = [
    "MODE: mutate_program",
    `PROBLEM: ${def.title_en}`,
    `STATEMENT: ${def.statement_en}`,
    `DIRECTION: ${def.direction === "max" ? "maximise" : "minimise"} the score`,
    `INSTANCE: ${inst}`,
    bestKnown !== undefined && bestKnown !== null ? `BEST KNOWN SCORE (literature): ${bestKnown}` : "",
    `PARENT SCORE: ${parent.score}`,
    `PARENT PROGRAM:\n\`\`\`js\n${parent.code}\n\`\`\``,
    insp,
    "Write an improved full program (change the algorithm, not only the constants, when that helps).",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

/** The last ```js / ```javascript block (or any fenced block) that declares construct(). */
export function extractProgram(text: string): string | null {
  if (typeof text !== "string") return null;
  const blocks = [...text.matchAll(/```[ \t]*(js|javascript|ts)?[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1] ?? "", body: m[2] }));
  const withConstruct = blocks.filter((b) => /function\s+construct\s*\(|(var|let|const)\s+construct\s*=/.test(b.body));
  const pick = withConstruct.filter((b) => b.lang).pop() ?? withConstruct.pop();
  if (!pick) return null;
  const code = pick.body.trim();
  if (!code || new TextEncoder().encode(code).length > MAX_PROGRAM_BYTES) return null;
  return code;
}

/** Cheap static guard before spending a sandbox run on a child. */
export function programProblems(code: string): string[] {
  const e: string[] = [];
  if (typeof code !== "string" || !code.trim()) return ["empty program"];
  if (new TextEncoder().encode(code).length > MAX_PROGRAM_BYTES) e.push(`program larger than ${MAX_PROGRAM_BYTES} bytes`);
  if (!/function\s+construct\s*\(|(var|let|const)\s+construct\s*=/.test(code)) e.push("program does not declare construct(input)");
  return e;
}
