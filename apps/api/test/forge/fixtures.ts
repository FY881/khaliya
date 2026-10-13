import type { Adversary, Critic, ForgeToolSpec } from "../../src/forge/types";

export const SLUGIFY_CODE = `function run(x) {
  var s = String(x.text).toLowerCase();
  var out = "";
  var dash = false;
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    var ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    if (ok) { out += c; dash = false; }
    else if (!dash && out.length) { out += "-"; dash = true; }
  }
  if (out.endsWith("-")) out = out.slice(0, -1);
  return { slug: out.slice(0, x.max || 60) };
}`;

export function slugifySpec(over: Partial<ForgeToolSpec> = {}): ForgeToolSpec {
  return {
    name: "forge.text.slugify",
    description: "Turn a title into a lowercase URL slug (ASCII letters and digits joined by dashes).",
    input_schema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", maxLength: 500 }, max: { type: "integer", minimum: 1, maximum: 200 } },
    },
    output_schema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
    code: SLUGIFY_CODE,
    tests: [
      { input: { text: "Hello, World!" }, expect: { slug: "hello-world" } },
      { input: { text: "  Khaliya  P4 Tool Forge " }, expect: { slug: "khaliya-p4-tool-forge" } },
      { input: { text: "abc def", max: 3 }, checker: { type: "regex", pattern: '"slug":"abc"' } },
    ],
    author: "agent:toolsmith-1",
    lineage: "lin_toolsmith",
    ...over,
  };
}

export const approveCritic = (lineage = "lin_critic"): Critic & { seen: { warnings: string[] }[] } => {
  const seen: { warnings: string[] }[] = [];
  return {
    lineage,
    seen,
    async review(i) {
      seen.push({ warnings: i.warnings });
      return { approve: true, reason: "looks fine", risk: "low" };
    },
  };
};

export const fixedAdversary = (inputs: unknown[], lineage = "lin_evaluator"): Adversary => ({ lineage, generate: async () => inputs });

/** Golomb ruler verifier: marks must be distinct non-negative integers starting at 0 with all pairwise differences distinct. Score = ruler length (lower is better). */
export const GOLOMB_VERIFIER = `function verify(x) {
  var m = x.solution;
  var n = x.instance && x.instance.order;
  if (!Array.isArray(m) || m.length < 2) return { valid: false, detail: "need an array of at least 2 marks" };
  if (n && m.length !== n) return { valid: false, detail: "expected " + n + " marks" };
  for (var i = 0; i < m.length; i++) if (!Number.isInteger(m[i]) || m[i] < 0) return { valid: false, detail: "marks must be non-negative integers" };
  var s = m.slice().sort(function (a, b) { return a - b; });
  if (s[0] !== 0) return { valid: false, detail: "first mark must be 0" };
  var seen = {};
  for (var a = 0; a < s.length; a++) for (var b = a + 1; b < s.length; b++) {
    var d = s[b] - s[a];
    if (d === 0) return { valid: false, detail: "duplicate mark " + s[a] };
    if (seen[d]) return { valid: false, detail: "repeated difference " + d };
    seen[d] = true;
  }
  return { valid: true, score: s[s.length - 1], detail: "length " + s[s.length - 1] };
}`;
