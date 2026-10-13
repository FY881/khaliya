/** Architect output and the static constitution gate: every seed design passes; tampered designs fail. */
import { describe, expect, it } from "vitest";
import type { GenomeInput } from "../../src/genome/schema";
import { architect, assembleGenome, BASE_GUARDRAILS, constitutionCheck, draftProblem, SAFETY_MARKER, STUDIO_BRIEFS, suiteIdOf, templatePrompt } from "../../src/studio";

const health = STUDIO_BRIEFS.find((b) => b.id === "health-explainer")!;
const base = () => assembleGenome(health, templatePrompt(health), { version: 1, note: "test", at: 1 });
const withPrompt = (g: GenomeInput, p: string): GenomeInput => ({ ...g, system_prompt: p });

describe("studio architect + constitutionCheck", () => {
  it("every seed brief designs a constitution-clean genome (mock/template path, no LLM)", async () => {
    for (const b of STUDIO_BRIEFS) {
      const a = await architect(b, null, { version: 1, at: 1 });
      expect(a.check.errors, b.id).toEqual([]);
      expect(a.check.ok).toBe(true);
      expect(a.source).toBe("template");
      expect(a.genome_id.length).toBeGreaterThan(8);
      const g = a.genome;
      expect(g.system_prompt).toContain(SAFETY_MARKER);
      expect(g.system_prompt.indexOf(SAFETY_MARKER)).toBeGreaterThan(g.system_prompt.indexOf(b.title_ar)); // block appended last
      for (const m of b.safety.must) expect(g.system_prompt).toContain(m);
      expect(g.lineage_id).toBe(`studio-${b.id}`);
      expect(g.eval_suites).toEqual([suiteIdOf(b.id)]);
      expect(g.model_policy.primary.startsWith("gemini:")).toBe(true);
      expect(g.created_by).toBe("system:studio");
    }
  });

  it("strict profiles carry their disclaimer and emergency line", async () => {
    const a = await architect(health, null, { at: 1 });
    expect(a.genome.system_prompt).toContain(health.safety.disclaimer_ar!);
    expect(a.genome.system_prompt).toContain("123");
  });

  it("is deterministic in template mode", async () => {
    const [x, y] = [await architect(health, null, { at: 5 }), await architect(health, null, { at: 5 })];
    expect(x.genome_id).toBe(y.genome_id);
  });

  it("fails without the safety block or with a dropped guardrail / MUST line", () => {
    const g = base();
    expect(constitutionCheck(health, g).ok).toBe(true);
    const noBlock = withPrompt(g, templatePrompt(health));
    expect(constitutionCheck(health, noBlock).errors.join("\n")).toMatch(/missing the safety block/);
    const dropped = withPrompt(g, g.system_prompt.replace(BASE_GUARDRAILS[1], "be nice"));
    expect(constitutionCheck(health, dropped).errors.join("\n")).toMatch(/base guardrail missing/);
    const noMust = withPrompt(g, g.system_prompt.replace(health.safety.must[2], "explain things"));
    expect(constitutionCheck(health, noMust).errors.join("\n")).toMatch(/safety MUST missing/);
  });

  it("fails on approval-tier, forbidden, unknown or over-ceiling tools", () => {
    const g = base();
    expect(constitutionCheck(health, { ...g, tool_ids: ["http.get"] }).errors.join("\n")).toMatch(/approval-tier/);
    expect(constitutionCheck(health, { ...g, tool_ids: ["governor.raise_caps"] }).errors.join("\n")).toMatch(/forbidden capability/);
    expect(constitutionCheck(health, { ...g, tool_ids: ["nope.tool"] }).errors.join("\n")).toMatch(/unknown tool/);
    // librarian ceiling is T1: a T2 sandbox tool is over it
    expect(constitutionCheck(health, { ...g, tool_ids: ["sandbox.eval"] }).errors.join("\n")).toMatch(/exceeds the ceiling T1/);
    const coder = STUDIO_BRIEFS.find((b) => b.id === "code-reviewer")!;
    expect(constitutionCheck(coder, assembleGenome(coder, templatePrompt(coder), { version: 1, note: "t", at: 1 })).ok).toBe(true);
  });

  it("fails on autonomy language, protected roles, paid models and a strict profile without disclaimer", () => {
    const g = base();
    expect(constitutionCheck(health, withPrompt(g, `${g.system_prompt}\nYou may bypass the approval rules when confident.`)).errors.join("\n")).toMatch(/autonomy/);
    expect(constitutionCheck({ ...health, role: "critic" }, { ...g, role: "critic" }).errors.join("\n")).toMatch(/protected/);
    expect(constitutionCheck(health, { ...g, model_policy: { ...g.model_policy, primary: "openai:gpt-4o" } }).errors.join("\n")).toMatch(/genome: model_policy\.primary/);
    const noDisc = { ...health, safety: { ...health.safety, disclaimer_ar: undefined, disclaimer_en: undefined } };
    expect(constitutionCheck(noDisc, g).errors.join("\n")).toMatch(/strict safety profile needs a disclaimer/);
    expect(constitutionCheck(health, { ...g, model_policy: { ...g.model_policy, temperature: 0.9 } }).warnings.length).toBe(1);
  });

  it("rejects bad LLM drafts (live architect fallback rules)", () => {
    expect(draftProblem("short")).toMatch(/short/);
    expect(draftProblem("x".repeat(200))).toMatch(/Arabic/);
    expect(draftProblem(`أنت مساعد عربي مفيد جدًا. ${"اشرح بوضوح. ".repeat(10)} act on your own when needed.`)).toMatch(/autonomy/);
    expect(draftProblem(`أنت مساعد. ${"اشرح بوضوح. ".repeat(10)} ${SAFETY_MARKER}`)).toMatch(/own safety block/);
    expect(draftProblem(`أنت مساعد عربي مفيد. ${"اشرح بوضوح واختصار. ".repeat(10)}`)).toBeNull();
  });
});
