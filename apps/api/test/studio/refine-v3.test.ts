/** Refiner fixes (2026-10-13): precise draft-rejection reasons, bigger reply budget, per-domain failure hints. */
import { describe, expect, it } from "vitest";
import { ARCHITECT_MAX_TOKENS, parseDraft } from "../../src/studio/architect";
import { DOMAIN_FAILURE_HINT, FAILURE_HINT, failureHint, REFINE_BODY_CHARS, refineMessages, revisionNotes } from "../../src/studio/craft";
import { draftProblem, STUDIO_BRIEFS, templatePrompt } from "../../src/studio";

const brief = (id: string) => STUDIO_BRIEFS.find((b) => b.id === id)!;

describe("refiner draft parsing", () => {
  it("a reply cut off at the token limit is reported as cut off, not 'too short'", () => {
    const cut = '{"system_prompt": "أنت «ملخّص الأبحاث». ' + "اكتب بدقة. ".repeat(200);
    expect(parseDraft(cut).problem).toMatch(/cut off/);
    expect(parseDraft("Sure! Here is the prompt.").problem).toMatch(/not JSON/);
    expect(parseDraft('{"note": "x"}').problem).toMatch(/no system_prompt/);
    const ok = parseDraft(JSON.stringify({ system_prompt: "أنت مساعد. ".repeat(20), note: "n" }));
    expect(ok.problem).toBeUndefined();
    expect(ok.note).toBe("n");
    expect(draftProblem(ok.prompt)).toBeNull();
    expect(draftProblem("قصير")).toMatch(/too short \(4 chars\)/);
  });

  it("the reply budget fits a full-length Arabic prompt inside JSON", () => {
    // ~1 token per 2.5 Arabic chars, JSON escaping and the note on top
    expect(ARCHITECT_MAX_TOKENS).toBeGreaterThanOrEqual(Math.ceil((3500 / 2.5) * 1.6));
    expect(REFINE_BODY_CHARS).toBeLessThanOrEqual(3500);
  });
});

describe("per-domain failure hints", () => {
  it("research gets its own missing_content hint (no code-review advice), others fall back to the generic one", () => {
    const r = failureHint("missing_content", "research");
    expect(r).not.toBe(FAILURE_HINT.missing_content);
    expect(r).not.toMatch(/current behaviour|the fix|corrected code/i);
    expect(r).toMatch(/sources/);
    expect(failureHint("missing_content", "code-review")).toMatch(/corrected code/);
    expect(failureHint("missing_content", "calendar")).toBe(FAILURE_HINT.missing_content);
    expect(failureHint("too_long", "research")).toBe(FAILURE_HINT.too_long);
    expect(FAILURE_HINT.missing_content).not.toMatch(/current behaviour/);
  });

  it("refine prompt and revision notes use the brief's domain hint", () => {
    const b = brief("research-summarizer");
    const f = [{ key: "unanswered", kind: "capability" as const, task: "x", answer: "y", cls: "missing_content" as const }];
    const text = refineMessages(b, templatePrompt(b), f).map((m) => m.content).join("\n");
    expect(text).toContain(JSON.stringify(DOMAIN_FAILURE_HINT.research.missing_content).slice(1, 60));
    expect(text).toContain(String(REFINE_BODY_CHARS));
    expect(revisionNotes(f, 1, "research")).toContain(DOMAIN_FAILURE_HINT.research.missing_content!);
  });

  it("no domain hint names a checker keyword or a reference answer of its domain's briefs", () => {
    for (const b of STUDIO_BRIEFS) {
      const hints = Object.values(DOMAIN_FAILURE_HINT[b.safety.domain] ?? {}).join("\n");
      for (const t of b.tasks) {
        expect(hints.includes(t.reference), `${b.id}.${t.key}`).toBe(false);
        const c = t.checker as any;
        for (const k of [...(c.all ?? []), ...(c.any ?? [])]) if (/[\u0600-\u06FF]/.test(k)) expect(hints.includes(k), `${b.id}.${t.key}: ${k}`).toBe(false);
      }
    }
  });
});
