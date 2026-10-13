/**
 * Deterministic mock "Researcher LLM" for program mutation (MODE: mutate_program), used when the lab runs
 * in mock mode (tests, offline). It behaves like a cautious model: it starts from the best program it was
 * shown (parent or inspiration), changes one or two knobs, and returns a full program in a ```js block.
 * Markers for tests: "MOCK:no-code" in the parent ⇒ a reply with no code block; "MOCK:broken" ⇒ a program
 * that throws.
 */
import { hashSeed, mulberry32 } from "../evolution/bandit";
import { tweak } from "./mutate";

function blocks(prompt: string): { label: string; score: number | null; code: string }[] {
  const out: { label: string; score: number | null; code: string }[] = [];
  const re = /(PARENT PROGRAM|INSPIRATION \d+ \(score ([^)]*)\)):?\s*\n```js\n([\s\S]*?)\n```/g;
  const parentScore = Number(prompt.match(/^PARENT SCORE:\s*(.*)$/m)?.[1]);
  for (const m of prompt.matchAll(re)) {
    const isParent = m[1] === "PARENT PROGRAM";
    const s = isParent ? parentScore : Number(m[2]);
    out.push({ label: m[1], score: Number.isFinite(s) ? s : null, code: m[3] });
  }
  return out;
}

export function mockProgramBrain(prompt: string): string {
  const progs = blocks(prompt);
  const parent = progs.find((p) => p.label === "PARENT PROGRAM");
  if (!parent) return "I could not find the parent program.";
  if (parent.code.includes("MOCK:no-code")) return "Here is my idea: use a smarter search. (no code)";
  if (parent.code.includes("MOCK:broken")) return "```js\nfunction construct(input) { throw new Error('boom'); }\n```";
  const maximise = /^DIRECTION:\s*maximise/m.test(prompt);
  const scored = progs.filter((p) => p.score !== null);
  scored.sort((a, b) => (maximise ? b.score! - a.score! : a.score! - b.score!));
  const base = scored[0] ?? parent;
  const rng = mulberry32(hashSeed(prompt));
  let code = base.code;
  const notes: string[] = [];
  for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {
    const t = tweak(code, rng);
    if (t) {
      code = t.code;
      notes.push(t.note);
    }
  }
  return `I started from the strongest program and adjusted ${notes.join("; ") || "nothing"}.\n\n\`\`\`js\n${code}\n\`\`\``;
}
