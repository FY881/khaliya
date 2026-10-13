import { describe, expect, it } from "vitest";
import { finalizeGenome, genomeId, validateGenome, verifyGenomeId, type GenomeInput } from "../src/genome/schema";
import { STARTER_ORG, starterGenome } from "../src/registry/seed";
import { canonicalJson } from "../src/util";

const base = (): GenomeInput => starterGenome(STARTER_ORG.find((s) => s.role === "builder")!);

describe("genome content hashing", () => {
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });

  it("same content → same id regardless of key order, id field or created_at", async () => {
    const g1 = base();
    const shuffled = Object.fromEntries(Object.entries(base()).reverse()) as GenomeInput;
    const a = await finalizeGenome({ ...g1, created_at: 1 });
    const b = await finalizeGenome({ ...shuffled, created_at: 999, id: "whatever" });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^g_[0-9a-f]{32}$/);
  });

  it("tool_ids are a set: order/duplicates do not change the hash", async () => {
    const a = await finalizeGenome({ ...base(), tool_ids: ["think", "memory.write"] });
    const b = await finalizeGenome({ ...base(), tool_ids: ["memory.write", "think", "think"] });
    expect(a.id).toBe(b.id);
  });

  it("any content change → different id", async () => {
    const a = await finalizeGenome(base());
    const b = await finalizeGenome({ ...base(), system_prompt: base().system_prompt + " Be brief." });
    const c = await finalizeGenome({ ...base(), version: 2 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("verifyGenomeId detects tampering", async () => {
    const g = await finalizeGenome(base());
    expect(await verifyGenomeId(g)).toBe(true);
    expect(await verifyGenomeId({ ...g, system_prompt: "tampered prompt here" })).toBe(false);
    expect(await genomeId(g)).toBe(g.id);
  });
});

describe("genome validation", () => {
  it("all 8 starter genomes are valid", async () => {
    expect(STARTER_ORG.map((s) => s.role).sort()).toEqual(["architect", "auditor", "builder", "critic", "director", "evaluator", "librarian", "researcher"]);
    for (const s of STARTER_ORG) {
      const v = validateGenome(await finalizeGenome(starterGenome(s)));
      expect(v.errors).toEqual([]);
    }
  });

  it("rejects non-free OpenRouter models and unknown providers", async () => {
    const g = await finalizeGenome({ ...base(), model_policy: { primary: "openrouter:openai/gpt-4o", fallbacks: ["anthropic:claude"], temperature: 0.2 } });
    const v = validateGenome(g);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/gpt-4o.*not an allowed free model/);
    expect(v.errors.join(" ")).toMatch(/anthropic:claude/);
  });

  it("rejects budgets above constitutional hard caps", async () => {
    const v = validateGenome(await finalizeGenome({ ...base(), budget_profile: { max_steps: 999, max_tokens: 10 } }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("max_steps") && e.includes("constitutional"))).toBe(true);
  });

  it("rejects forbidden capabilities (governor/constitution/approval tools)", async () => {
    const v = validateGenome(await finalizeGenome({ ...base(), tool_ids: ["think", "governor.set_caps", "approval.approve"] }));
    expect(v.ok).toBe(false);
    expect(v.errors.filter((e) => e.startsWith("forbidden capability")).length).toBe(2);
  });

  it("rejects bad role / strategy / missing fields", () => {
    const v = validateGenome({ lineage_id: "X Y", role: "king", version: 0 });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(5);
  });
});
