import { describe, expect, it } from "vitest";
import { evaluateTool, isCrash, llmAdversary, llmCritic, staticScan, structureProblems, toolHash } from "../../src/forge/admission";
import { fuzzInputs } from "../../src/forge/fuzz";
import { runSandboxed, type SandboxRequest } from "../../src/forge/sandbox";
import { approveCritic, fixedAdversary, slugifySpec } from "./fixtures";

const gateOf = (r: Awaited<ReturnType<typeof evaluateTool>>, g: string) => r.gates.find((x) => x.gate === g)!;

describe("forge admission: happy path", () => {
  it("admits a well-behaved tool through every gate", async () => {
    const critic = approveCritic();
    const r = await evaluateTool(slugifySpec(), { critic, adversary: fixedAdversary([{ text: "" }, { text: "---" }, { text: "Ünïcode 😀", max: 1 }]) });
    expect(r.status).toBe("admitted");
    expect(r.gates.map((g) => [g.gate, g.pass])).toEqual([
      ["structure", true],
      ["static", true],
      ["author_tests", true],
      ["adversarial", true],
      ["determinism", true],
      ["budget", true],
      ["critic", true],
    ]);
    expect(r.stats.hiddenTests).toBeGreaterThanOrEqual(10);
    expect(gateOf(r, "adversarial").detail).toMatchObject({ from_adversary: 3 });
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(critic.seen).toHaveLength(1);
  });

  it("content hash is stable and ignores author/lineage", async () => {
    const a = await toolHash(slugifySpec());
    expect(await toolHash(slugifySpec({ author: "owner", lineage: "x" }))).toBe(a);
    expect(await toolHash(slugifySpec({ description: "Different description for the same slug code." }))).not.toBe(a);
  });

  it("schema fuzzing is deterministic and schema-valid", () => {
    const s = slugifySpec().input_schema;
    const a = fuzzInputs(s, 12, 7);
    expect(a).toEqual(fuzzInputs(s, 12, 7));
    expect(a.length).toBeGreaterThanOrEqual(10);
    expect(a.some((x: any) => x.text === "")).toBe(true);
  });
});

describe("forge admission: structure gate", () => {
  const probs = (o: Parameters<typeof slugifySpec>[0]) => structureProblems(slugifySpec(o), ["forge.taken"]);
  it("enforces the forge.* namespace and name rules", () => {
    expect(probs({ name: "text.slugify" }).join()).toMatch(/forge\.\* namespace/);
    expect(probs({ name: "forge.Text" }).join()).toMatch(/lowercase/);
    expect(probs({ name: "forge.governor.reset" }).join()).toMatch(/forbidden|reserved/);
    expect(probs({ name: "forge.auth.peek" }).join()).toMatch(/forbidden|reserved/);
    expect(probs({ name: "forge.net.get" }).join()).toMatch(/reserved/);
    expect(probs({ name: "forge.taken" }).join()).toMatch(/built-in/);
    expect(probs({})).toEqual([]);
  });

  it("rejects bad tests, schemas and limits", () => {
    expect(probs({ tests: [] }).join()).toMatch(/tests/);
    expect(probs({ tests: [{ input: { text: "a" } }] }).join()).toMatch(/exactly one/);
    expect(probs({ tests: [{ input: { text: "a" }, expect: 1, checker: { type: "exact", value: "1" } }] }).join()).toMatch(/exactly one/);
    expect(probs({ tests: [{ input: { nope: 1 }, expect: 1 }] }).join()).toMatch(/violates input_schema/);
    expect(probs({ tests: [{ input: { text: "a" }, checker: { type: "rubric" } as any }] }).join()).toMatch(/rubric/);
    expect(probs({ input_schema: { type: "string" } }).join()).toMatch(/input_schema/);
    expect(probs({ limits: { fuel: 1e9 } }).join()).toMatch(/limits\.fuel/);
    expect(probs({ limits: { bogus: 1 } as any }).join()).toMatch(/unknown limit/);
    expect(probs({ lineage: "" }).join()).toMatch(/lineage/);
  });

  it("evaluateTool rejects at structure and skips the rest", async () => {
    const r = await evaluateTool(slugifySpec({ name: "forge.kill.all" }), { critic: approveCritic() });
    expect(r.status).toBe("rejected");
    expect(gateOf(r, "structure").pass).toBe(false);
    expect(r.gates.filter((g) => g.skipped).length).toBe(6);
    expect(r.stats.runs).toBe(0);
  });
});

describe("forge admission: static gate", () => {
  it("hard-rejects missing entry, minified lines and bidi tricks", () => {
    expect(staticScan(slugifySpec({ code: "function other(){}" })).hard.join()).toMatch(/does not declare entry/);
    expect(staticScan(slugifySpec({ code: "function run(){ return 1 }" + ";".repeat(2100) })).hard.join()).toMatch(/longer than/);
    expect(staticScan(slugifySpec({ code: "function run(){ return 1 } // \u202e" })).hard.join()).toMatch(/bidi/);
    expect(staticScan(slugifySpec({ code: "x".repeat(33 * 1024) + "\nfunction run(){}" })).hard.join()).toMatch(/bytes/);
  });

  it("flags eval / Function / import / while(true) as warnings (not rejections)", () => {
    const w = staticScan(slugifySpec({ code: "function run(){ eval('1'); new Function('return 1'); while(true){ break } (function(){}).constructor.constructor; return 1 }" })).warnings.join("|");
    expect(w).toMatch(/eval/);
    expect(w).toMatch(/Function/);
    expect(w).toMatch(/unbounded loop/);
    expect(w).toMatch(/constructor/);
  });

  it("warnings reach the critic, which can still reject", async () => {
    const code = "function run(x){ var y = eval('1'); return { slug: 'hello-world' } }";
    let seen: string[] = [];
    const r = await evaluateTool(
      slugifySpec({ code, tests: [{ input: { text: "Hello, World!" }, expect: { slug: "hello-world" } }] }),
      { critic: { lineage: "lin_critic", review: async (i) => ((seen = i.warnings), { approve: false, reason: "uses eval and ignores its input", risk: "medium" }) } },
    );
    expect(gateOf(r, "static").pass).toBe(true);
    expect(seen.join()).toMatch(/eval/);
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/critic: uses eval/);
  });
});

describe("forge admission: author tests, adversarial, determinism, budget", () => {
  it("rejects when an author test fails", async () => {
    const r = await evaluateTool(slugifySpec({ tests: [{ input: { text: "A B" }, expect: { slug: "a_b" } }] }), { critic: approveCritic() });
    expect(r.status).toBe("rejected");
    expect(gateOf(r, "author_tests").reason).toMatch(/got/);
  });

  it("numeric and json_schema checkers work for author tests", async () => {
    const spec = slugifySpec({
      name: "forge.math.mean",
      description: "Arithmetic mean of a non-empty list of numbers.",
      input_schema: { type: "object", required: ["xs"], properties: { xs: { type: "array", minItems: 1, maxItems: 50, items: { type: "number" } } } },
      output_schema: { type: "number" },
      code: "function run(x){ var s = 0; for (var i = 0; i < x.xs.length; i++) s += x.xs[i]; return s / x.xs.length }",
      tests: [
        { input: { xs: [1, 2, 3, 4] }, checker: { type: "numeric", value: 2.5 } },
        { input: { xs: [10] }, checker: { type: "json_schema", schema: { type: "number", minimum: 10, maximum: 10 } } },
      ],
    });
    const r = await evaluateTool(spec, { critic: approveCritic() });
    expect(r.status).toBe("admitted");
  });

  it("hidden fuzz tests catch a tool that crashes on empty input", async () => {
    const code = "function run(x){ return { slug: x.text[0].toLowerCase() + x.text.slice(1) } }";
    const r = await evaluateTool(slugifySpec({ code, tests: [{ input: { text: "Abc" }, expect: { slug: "abc" } }] }), { critic: approveCritic() });
    expect(r.status).toBe("rejected");
    expect(gateOf(r, "adversarial").reason).toMatch(/TypeError/);
    expect(r.stats.crashes).toBeGreaterThan(0);
  });

  it("an intentional Error on bad-but-valid input is not a crash; a timeout is", () => {
    const base = { ms: 1, fuelUsed: 1, fuelExceeded: false, memExceeded: false, outputBytes: 0, ok: false };
    expect(isCrash({ ...base, errorKind: "throw", error: "Error: text must not be empty" })).toBe(false);
    expect(isCrash({ ...base, errorKind: "throw", error: "TypeError: cannot read property" })).toBe(true);
    expect(isCrash({ ...base, errorKind: "fuel", error: "fuel budget exceeded", fuelExceeded: true })).toBe(true);
  });

  it("uses adversary inputs from another lineage and drops schema-invalid ones", async () => {
    // Passes the fuzzer, but loops forever on one specific value only an adversary would think of.
    const code = "function run(x){ if (x.text === 'Robert\\'); DROP TABLE') { for(;;){} } return { slug: 'ok' } }";
    const spec = slugifySpec({ code, tests: [{ input: { text: "x" }, expect: { slug: "ok" } }], limits: { fuel: 200 } });
    const evil = [{ text: "Robert'); DROP TABLE" }, { nope: true }];
    const r = await evaluateTool(spec, { critic: approveCritic(), adversary: fixedAdversary(evil) });
    expect(r.status).toBe("rejected");
    expect(gateOf(r, "adversarial").reason).toMatch(/fuel/);
    expect(gateOf(r, "adversarial").detail).toMatchObject({ from_adversary: 1, adversary_dropped: 1 });
  });

  it("ignores an adversary from the author's own lineage", async () => {
    const r = await evaluateTool(slugifySpec(), { critic: approveCritic(), adversary: fixedAdversary([{ text: "x" }], "lin_toolsmith") });
    expect(r.status).toBe("admitted");
    expect(r.warnings.join()).toMatch(/shares the author's lineage/);
    expect(gateOf(r, "adversarial").detail).toMatchObject({ from_adversary: 0 });
  });

  it("rejects non-deterministic behaviour (instrumented runner)", async () => {
    let n = 0;
    const flaky = async (req: SandboxRequest) => {
      const r = await runSandboxed(req);
      return ++n % 7 === 0 && r.ok ? { ...r, value: { slug: "different" } } : r;
    };
    const r = await evaluateTool(slugifySpec(), { critic: approveCritic(), runner: flaky, fuzzCases: 3 });
    expect(r.status).toBe("rejected");
    expect(gateOf(r, "determinism").pass).toBe(false);
  });

  it("budget gate: rejects a tool that runs too close to its own fuel limit", async () => {
    const code = "function run(x){ var s = 0; for (var i = 0; i < 150000; i++) s += i; return { slug: String(s % 7) } }";
    const r = await evaluateTool(slugifySpec({ code, tests: [{ input: { text: "x" }, checker: { type: "regex", pattern: "slug" } }], limits: { fuel: 40 } }), {
      critic: approveCritic(),
      fuzzCases: 2,
    });
    expect(r.status).toBe("rejected");
    expect(gateOf(r, "budget").reason).toMatch(/peak fuel/);
  });
});

describe("forge admission: critic gate", () => {
  it("rejects without a critic, with a same-lineage critic, on high risk, and on critic error", async () => {
    const spec = slugifySpec();
    expect((await evaluateTool(spec, { fuzzCases: 2 })).reason).toMatch(/no critic/);
    expect((await evaluateTool(spec, { fuzzCases: 2, critic: approveCritic("lin_toolsmith") })).reason).toMatch(/shares the author's lineage/);
    const high = { lineage: "lin_critic", review: async () => ({ approve: true, reason: "ok but risky", risk: "high" as const }) };
    expect((await evaluateTool(spec, { fuzzCases: 2, critic: high })).status).toBe("rejected");
    const boom = { lineage: "lin_critic", review: async () => Promise.reject(new Error("llm down")) };
    expect((await evaluateTool(spec, { fuzzCases: 2, critic: boom })).reason).toMatch(/critic error: llm down/);
  });

  it("llmCritic / llmAdversary parse LLM replies (mock LLM)", async () => {
    let prompt = "";
    const ok = llmCritic(async (p) => ((prompt = p), '```json\n{"approve": true, "reason": "pure string code", "risk": "low"}\n```'), "lin_critic");
    expect((await ok.review({ spec: slugifySpec(), warnings: [], gates: [] })).approve).toBe(true);
    expect(prompt).toContain("forge.text.slugify");
    const junk = llmCritic(async () => "sure, looks good!", "lin_critic");
    expect((await junk.review({ spec: slugifySpec(), warnings: [], gates: [] })).approve).toBe(false);
    const adv = llmAdversary(async () => 'Here: [{"text": ""}, {"text": "a"}]', "lin_eval");
    expect(await adv.generate(slugifySpec())).toEqual([{ text: "" }, { text: "a" }]);
    const r = await evaluateTool(slugifySpec(), { critic: ok, adversary: adv, fuzzCases: 4 });
    expect(r.status).toBe("admitted");
  });
});
