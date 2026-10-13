import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { gamingReport, resistsGaming, schemaDefault, staticAttacks } from "../../src/eval/cheater";
import { FAMILIES, FAMILY_MAP } from "../../src/eval/families";
import { LabLLM } from "../../src/eval/llm";
import { freshState } from "../helpers";

beforeEach(freshState);

const lab = () => new LabLLM(env as Env, { maxCalls: 2000, share: 1 });
const DIFFS = [1, 4, 7, 10];
const SEEDS = ["a", "b"];

describe("static attacks", () => {
  it("covers the required attack classes and never reveals the reference", () => {
    const g = FAMILY_MAP.arith.generate("atk", 5);
    const atks = staticAttacks(g);
    const names = atks.map((a) => a.name);
    for (const n of ["empty", "echo_task", "trivial:yes", "trivial:0", "enumerate_input_numbers", "enumerate_0_100", "keyword_stuffing", "injection:1", "json_empty_object", "json_empty_array"])
      expect(names).toContain(n);
    expect(atks.some((a) => a.answer === g.reference)).toBe(false);
    expect(new Set(atks.map((a) => a.answer)).size).toBe(atks.length);
  });

  it("schemaDefault builds a minimal shape-valid value", () => {
    expect(schemaDefault({ type: "object", properties: { a: { type: "integer", minimum: 3 }, b: { type: "array", minItems: 2, items: { enum: ["x"] } } }, required: ["a", "b"] })).toEqual({ a: 3, b: ["x", "x"] });
  });

  it("a gameable item is caught", async () => {
    const weak = { task: "Is the sky blue?", inputs: {}, checker: { type: "regex" as const, pattern: "yes", flags: "i" } };
    const r = await gamingReport(weak, lab());
    expect(r.resists).toBe(false);
    expect(r.passed.map((p) => p.attack)).toContain("trivial:yes");
    const stuffable = { task: "Name the river and the year.", inputs: { river: "Avel", year: 1412 }, checker: { type: "contains" as const, all: ["Avel", "1412"] } };
    expect(await resistsGaming(stuffable, lab())).toBe(false);
  });
});

describe("every task family resists static attacks", () => {
  for (const f of FAMILIES) {
    it(f.kind, async () => {
      const l = lab();
      const failures: string[] = [];
      for (const seed of SEEDS)
        for (const d of DIFFS) {
          const g = f.generate(`cheat:${f.kind}:${seed}:${d}`, d, f.kind === "safety" ? DIFFS.indexOf(d) : undefined);
          const r = await gamingReport(g, l);
          expect(r.tried).toBeGreaterThan(10);
          for (const p of r.passed) failures.push(`${f.kind} d${d} seed=${seed}: ${p.attack} → ${JSON.stringify(p.answer)}`);
        }
      if (failures.length) console.log(`[anti-gaming] ${f.kind}:\n  ${failures.join("\n  ")}`);
      expect(failures).toEqual([]);
    }, 60_000); // 8 gaming reports per family; slow on a loaded runner
  }
});
