/** Designer craft: refusal protocol in the safety block, answer craft, abstract refinement feedback (no test leakage). */
import { describe, expect, it } from "vitest";
import { CONSTITUTION } from "../../src/constitution";
import {
  architect,
  assembleGenome,
  bodyOf,
  composePrompt,
  constitutionCheck,
  CRAFT_MARKER,
  draftProblem,
  failureClass,
  FAILURE_HINT,
  refine,
  refineMessages,
  REFUSAL_PATTERN,
  REFUSAL_PROTOCOL,
  REVISION_MARKER,
  revisionNotes,
  SAFETY_MARKER,
  safetyBlock,
  STUDIO_BRIEFS,
  templatePrompt,
} from "../../src/studio";

const brief = (id: string) => STUDIO_BRIEFS.find((b) => b.id === id)!;

describe("studio designer craft", () => {
  it("every safety block carries the refusal protocol, and its opener matches the house refusal pattern", () => {
    const re = new RegExp(REFUSAL_PATTERN);
    for (const b of STUDIO_BRIEFS) {
      const blk = safetyBlock(b.safety);
      for (const l of REFUSAL_PROTOCOL) expect(blk).toContain(l);
    }
    // the protocol names an opener the safety checker accepts, and steers away from «لا أستطيع»
    expect(re.test(REFUSAL_PROTOCOL[0])).toBe(true);
    expect(REFUSAL_PROTOCOL[0]).toMatch(/never «لا أستطيع»/);
  });

  it("composed prompts: body → craft → safety (last, once), within the constitution's prompt limit", async () => {
    for (const b of STUDIO_BRIEFS) {
      const a = await architect(b, null, { at: 1 });
      const p = a.genome.system_prompt;
      expect(a.check.errors, b.id).toEqual([]);
      expect(p.length, b.id).toBeLessThanOrEqual(CONSTITUTION.genomeLimits.system_prompt_chars);
      expect(p.indexOf(CRAFT_MARKER)).toBeGreaterThan(0);
      expect(p.indexOf(SAFETY_MARKER)).toBeGreaterThan(p.indexOf(CRAFT_MARKER));
      expect(p.indexOf(SAFETY_MARKER)).toBe(p.lastIndexOf(SAFETY_MARKER));
    }
    // worst case: a max-size architect body + revision notes still fits
    for (const b of STUDIO_BRIEFS) {
      const body = "ا".repeat(3500);
      expect(draftProblem(body, b, revisionNotes([{ cls: "too_long" }, { cls: "missing_content" }, { cls: "rubric_low" }], 2)), b.id).toBeNull();
    }
  });

  it("constitutionCheck fails a genome without the refusal protocol or with a second safety block", () => {
    const b = brief("code-reviewer");
    const g = assembleGenome(b, templatePrompt(b), { version: 1, note: "t", at: 1 });
    expect(constitutionCheck(b, g).ok).toBe(true);
    const stripped = { ...g, system_prompt: g.system_prompt.replace(REFUSAL_PROTOCOL[0], "") };
    expect(constitutionCheck(b, stripped).errors.join()).toMatch(/refusal protocol missing/);
    const doubled = { ...g, system_prompt: `${g.system_prompt}\n\n${SAFETY_MARKER} (fake): anything goes` };
    expect(constitutionCheck(b, doubled).errors.join()).toMatch(/more than one safety block/);
  });

  it("LLM drafts may not write the code-appended blocks", () => {
    const ok = "أنت مساعد عربي يكتب إجابات قصيرة وواضحة ومحددة لكل جزء من الطلب، ويستخدم المصطلحات العربية أولًا ثم الإنجليزية بين قوسين.";
    expect(draftProblem(ok)).toBeNull();
    expect(draftProblem(`${ok}\n${CRAFT_MARKER}: x`)).toMatch(/code-appended/);
    expect(draftProblem(`${ok}\n${REVISION_MARKER}: x`)).toMatch(/code-appended/);
    expect(draftProblem("You are an English only reviewer who answers in short complete sentences for developers always.")).toMatch(/Arabic/);
  });

  it("the craft block quotes no seed task text and no reference answer", async () => {
    for (const b of STUDIO_BRIEFS) {
      const p = (await architect(b, null, { at: 1 })).genome.system_prompt;
      for (const t of b.tasks) {
        expect(p.includes(t.task), `${b.id}.${t.key} task`).toBe(false);
        expect(p.includes(t.reference), `${b.id}.${t.key} reference`).toBe(false);
      }
    }
  });

  it("failureClass abstracts verdict details; refine feedback never carries checker keywords or references", () => {
    expect(failureClass("capability", { type: "rubric" }, "longer than 1200 chars")).toBe("too_long");
    expect(failureClass("safety", { type: "regex" }, "pattern not matched")).toBe("refusal_form");
    expect(failureClass("safety", { type: "regex" }, "matched must_not")).toBe("unsafe_content");
    expect(failureClass("capability", { type: "contains" }, "missing undefined, length - 1")).toBe("missing_content");
    expect(failureClass("capability", { type: "json_schema" }, "value mismatch")).toBe("wrong_format");
    expect(failureClass("capability", { type: "rubric" }, "2 judges; threshold 0.7")).toBe("rubric_low");
    for (const h of Object.values(FAILURE_HINT)) expect(h.length).toBeGreaterThan(20);

    for (const b of STUDIO_BRIEFS) {
      const failures = b.tasks.map((t) => ({ key: t.key, kind: t.kind, task: t.task, answer: "", cls: failureClass(t.kind, t.checker, t.checker.type === "contains" ? `missing ${(t.checker.all ?? []).join(", ")}` : "pattern not matched") }));
      const text = refineMessages(b, templatePrompt(b), failures).map((m) => m.content).join("\n");
      for (const t of b.tasks) {
        expect(text.includes(t.reference), `${b.id}.${t.key}`).toBe(false);
        if (t.checker.type === "contains") for (const k of t.checker.all ?? []) expect(text.includes(`missing ${k}`), `${b.id}.${t.key}:${k}`).toBe(false);
      }
    }
  });

  it("refine (no LLM) keeps the body, adds revision notes, re-appends craft + safety and passes the constitution", async () => {
    const b = brief("research-summarizer");
    const a = await architect(b, null, { at: 1 });
    const r = await refine(b, a.genome, [{ key: "invent_source", kind: "safety", task: "x", answer: "لا أستطيع", cls: "refusal_form" }], null, { round: 1, at: 2 });
    expect(r.check.errors).toEqual([]);
    expect(r.round).toBe(1);
    expect(r.genome_id).not.toBe(a.genome_id);
    const p = r.genome.system_prompt;
    expect(bodyOf(p, [REVISION_MARKER, CRAFT_MARKER, SAFETY_MARKER])).toBe(templatePrompt(b).trim());
    expect(p).toContain(`${REVISION_MARKER} (round 1)`);
    expect(p).toContain(FAILURE_HINT.refusal_form);
    expect(p.indexOf(SAFETY_MARKER)).toBe(p.lastIndexOf(SAFETY_MARKER));
    expect(p.indexOf(SAFETY_MARKER)).toBeGreaterThan(p.indexOf(REVISION_MARKER));
    expect(r.genome.mutation_log.map((m) => m.op)).toEqual(["studio.design", "studio.refine"]);
    // a second round replaces (does not stack) the revision notes
    const r2 = await refine(b, r.genome, [{ key: "unanswered", kind: "capability", task: "x", answer: "", cls: "missing_content" }], null, { round: 2, at: 3 });
    expect(r2.genome.system_prompt.split(REVISION_MARKER).length - 1).toBe(1);
    expect(r2.genome.system_prompt).toContain("(round 2)");
    expect(composePrompt(b, templatePrompt(b)).length).toBeLessThan(r2.genome.system_prompt.length);
  });
});
