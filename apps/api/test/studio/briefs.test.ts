/** Seed brief validity: shape, admission gates, behaviours vs checkers, and resistance to the static red-team. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { gamingReport, staticAttacks } from "../../src/eval/cheater";
import { runDeterministic } from "../../src/eval/checkers";
import { LabLLM } from "../../src/eval/llm";
import { normalizeText } from "../../src/eval/text";
import { attacksFor, briefProblems, hasArabic, itemSpecOf, STUDIO_BRIEFS, toStored } from "../../src/studio";
import { freshState } from "../helpers";

const E = env as Env;

const EXPECTED = [
  "ar-writer",
  "socratic-tutor",
  "cv-reviewer",
  "small-business",
  "code-reviewer",
  "research-summarizer",
  "health-explainer",
  "eg-legal-explainer",
  "accessibility-simplifier",
  "paperwork-checklist",
  "hijri-helper",
  "data-to-chart",
];

const allTasks = STUDIO_BRIEFS.flatMap((b) => b.tasks.map((t) => ({ b, t })));

describe("studio seed briefs", () => {
  it("has the twelve agents with Arabic-first metadata and a valid shape", () => {
    expect(STUDIO_BRIEFS.map((b) => b.id)).toEqual(EXPECTED);
    expect(new Set(STUDIO_BRIEFS.map((b) => b.service.slug)).size).toBe(12);
    for (const b of STUDIO_BRIEFS) {
      expect(briefProblems(toStored(b)), b.id).toEqual([]);
      expect(hasArabic(b.title_ar) && hasArabic(b.purpose_ar), b.id).toBe(true);
      expect(b.tasks.length).toBeGreaterThanOrEqual(4);
      expect(b.tasks.length).toBeLessThanOrEqual(6);
      expect(b.tasks.some((t) => t.kind === "safety"), b.id).toBe(true);
      expect(b.tasks.every((t) => ["contains", "regex", "json_schema", "rubric"].includes(t.checker.type))).toBe(true);
    }
    const health = STUDIO_BRIEFS.find((b) => b.id === "health-explainer")!;
    expect(health.safety.level).toBe("strict");
    expect(health.safety.emergency_ar).toContain("123");
    expect(STUDIO_BRIEFS.find((b) => b.id === "eg-legal-explainer")!.safety.disclaimer_ar).toBeTruthy();
    expect(STUDIO_BRIEFS.find((b) => b.id === "hijri-helper")!.safety.must_not.join(" ")).toMatch(/fatwa/i);
  });

  it("every behaviour agrees with its checker (solve passes, wrong/unsafe fail)", () => {
    for (const { b, t } of allTasks) {
      const name = `${b.id}/${t.key}`;
      const good = t.solve!({});
      const bad = t.wrong!({});
      if (t.checker.type === "rubric") {
        const kws = t.checker.criteria.flatMap((c) => c.keywords ?? []);
        for (const k of kws) expect(good.toLowerCase().includes(k.toLowerCase()), `${name} good has ${k}`).toBe(true);
        expect(kws.every((k) => bad.includes(k)), `${name} bad must miss a keyword`).toBe(false);
        expect(/[.!?]/.test(good), `${name} good is prose`).toBe(true);
        continue;
      }
      expect(runDeterministic(t.checker, good).pass, `${name} solve`).toBe(true);
      expect(runDeterministic(t.checker, bad).pass, `${name} wrong`).toBe(false);
      if (t.unsafe) expect(runDeterministic(t.checker, t.unsafe({})).pass, `${name} unsafe`).toBe(false);
    }
  });

  it("no required phrase or rubric keyword is readable from the task or inputs", () => {
    for (const { b, t } of allTasks) {
      const spec = itemSpecOf(b, t);
      const seen = normalizeText(`${spec.task} ${JSON.stringify(spec.inputs)}`);
      const raw = `${spec.task} ${JSON.stringify(spec.inputs)}`.toLowerCase();
      const req = t.checker.type === "contains" ? (t.checker.all ?? []) : t.checker.type === "rubric" ? t.checker.criteria.flatMap((c) => c.keywords ?? []) : [];
      for (const k of req) {
        expect(raw.includes(k.toLowerCase()), `${b.id}/${t.key}: '${k}' leaks (raw)`).toBe(false);
        expect(seen.includes(normalizeText(k)), `${b.id}/${t.key}: '${k}' leaks (normalized)`).toBe(false);
      }
    }
  });

  it("code-checked items resist every static attack (refusal excepted on safety items)", () => {
    for (const { b, t } of allTasks) {
      if (t.checker.type === "rubric") continue;
      const spec = itemSpecOf(b, t);
      for (const a of staticAttacks(spec)) {
        if (t.kind === "safety" && a.name === "refusal") continue;
        expect(runDeterministic(t.checker, a.answer).pass, `${b.id}/${t.key} gamed by ${a.name}`).toBe(false);
      }
    }
  });

  describe("rubric items vs the judge panel", () => {
    beforeEach(freshState);
    it("resist the rubric attack subset with the mock judges", async () => {
      const lab = new LabLLM(E, { maxCalls: 400, share: 0.3 });
      for (const { b, t } of allTasks) {
        if (t.checker.type !== "rubric") continue;
        const spec = itemSpecOf(b, t);
        const g = await gamingReport(spec, lab, attacksFor(spec));
        expect(g.passed.map((p) => p.attack), `${b.id}/${t.key}`).toEqual([]);
        expect(g.tried).toBeGreaterThan(3);
      }
    }, 110_000);
  });
});

describe("accessibility-simplifier short_sentences measures sentence length", () => {
  const spec = () => {
    const b = STUDIO_BRIEFS.find((x) => x.id === "accessibility-simplifier")!;
    return itemSpecOf(b, b.tasks.find((x) => x.key === "short_sentences")!);
  };
  const ok = (a: string) => runDeterministic(spec().checker, a).pass;
  it("passes three genuinely short sentences (also with newlines between them)", () => {
    expect(ok("الفرع بيبقى زحمة الصبح. الخدمة محتاجة حضورك إنت شخصيًا. احضر بعد الساعة 2 الظهر ومعاك البطاقة.")).toBe(true);
    expect(ok("الفرع مزدحم في الصباح.\nيجب أن تحضر بنفسك.\nتعال بعد الثانية ظهرًا ومعك بطاقة الرقم القومي.\n")).toBe(true);
  });
  it("fails long sentences even with three full stops (the old pattern passed this)", () => {
    const long = "بسبب أن الفرع يكون مزدحمًا جدًا في ساعات الصباح الأولى وأن الخدمة تتطلب حضور صاحب الشأن نفسه شخصيًا إلى المكتب";
    expect(ok(`${long}. الخدمة شخصية. احضر بعد الثانية.`)).toBe(false);
    expect(ok("أ. ب. ج.")).toBe(false); // trivially short fragments
  });
  it("fails a fourth sentence, trailing text, semicolons and the original connector", () => {
    expect(ok("الفرع زحمة الصبح. لازم تحضر بنفسك. تعال بعد الساعة 2. خد بطاقتك معاك.")).toBe(false);
    expect(ok("الفرع زحمة الصبح. لازم تحضر بنفسك. تعال بعد الساعة 2. وخلاص")).toBe(false);
    expect(ok("الفرع زحمة الصبح؛ لازم تحضر بنفسك. تعال بعد الساعة 2. خد البطاقة.")).toBe(false);
    expect(ok("نظرًا للزحمة تعال بعدين. لازم تحضر بنفسك. خد البطاقة معاك.")).toBe(false);
  });
});
