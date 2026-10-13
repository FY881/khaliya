import { describe, expect, it } from "vitest";
import { finalizeGenome, type Genome, type GenomeInput } from "../../src/genome/schema";
import { STARTER_ORG, starterGenome } from "../../src/registry/seed";
import { mulberry32 } from "../../src/evolution/bandit";
import { prompt_rewrite, spawn_role, strategy_swap, tool_add } from "../../src/evolution/operators";
import {
  canJudge,
  genomeDistance,
  isProtectedLineage,
  judgeConflicts,
  MIN_NOVELTY,
  NOVELTY_WEIGHTS,
  novelty,
  staticChecks,
} from "../../src/evolution/checks";

const AT = 1_700_000_000_000;
const ctx = { at: AT, by: "agent:architect-1" };
const seedOf = (role: string): GenomeInput => starterGenome(STARTER_ORG.find((s) => s.role === role)!);
const make = (role: string, over: Partial<GenomeInput> = {}) => finalizeGenome({ ...seedOf(role), ...over }, 1);

describe("genomeDistance / novelty", () => {
  it("weights sum to 1", () => {
    expect(Object.values(NOVELTY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it("identical content → 0; symmetric; bounded", async () => {
    const a = await make("builder");
    const b = await make("researcher");
    expect(genomeDistance(a, a)).toBe(0);
    expect(genomeDistance(a, b)).toBeCloseTo(genomeDistance(b, a), 12);
    expect(genomeDistance(a, b)).toBeGreaterThan(0);
    expect(genomeDistance(a, b)).toBeLessThanOrEqual(1);
  });
  it("strategy swap alone is exactly its weight", async () => {
    const a = await make("builder");
    const c = await strategy_swap(a, mulberry32(1), ctx);
    expect(genomeDistance(a, c)).toBeCloseTo(NOVELTY_WEIGHTS.planning_strategy, 10);
  });
  it("novelty is distance to the nearest, 1 with no population, ignores self", async () => {
    const a = await make("builder");
    const b = await make("researcher");
    const c = await strategy_swap(a, mulberry32(1), ctx);
    expect(novelty(c, []).novelty).toBe(1);
    const n = novelty(c, [b, a, c]);
    expect(n.nearestId).toBe(a.id);
    expect(n.novelty).toBeCloseTo(0.1, 10);
  });
});

describe("staticChecks", () => {
  it("passes a proper child", async () => {
    const p = await make("builder");
    const c = await strategy_swap(p, mulberry32(2), ctx);
    const r = staticChecks(c, { existing: [p], parent: p, proposerRole: "architect" });
    expect(r.reasons).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.novelty).toBeGreaterThanOrEqual(MIN_NOVELTY);
  });
  it("rejects near-duplicates (novelty < 0.05)", async () => {
    const p = await make("builder");
    const c = await prompt_rewrite(p, p.system_prompt + " Be brief.", ctx);
    const r = staticChecks(c, { existing: [p], parent: p, proposerRole: "architect" });
    expect(r.novelty).toBeLessThan(0.05);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("novelty:"))).toBe(true);
    expect(staticChecks(c, { existing: [p], parent: p, minNovelty: 0 }).pass).toBe(true);
  });
  it("reports schema errors", async () => {
    const p = await make("builder");
    const bad = { ...p, planning_strategy: "yolo", model_policy: { ...p.model_policy, primary: "openrouter:openai/gpt-4o" } } as unknown as Genome;
    const r = staticChecks(bad, { existing: [] });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes("planning_strategy"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("not an allowed free model"))).toBe(true);
  });
  it("rejects forbidden prefixes, unknown tools and tier above ceiling", async () => {
    const p = await make("builder");
    const bad = { ...p, tool_ids: ["think", "governor.pause", "http.get", "nope.tool"], skills: ["audit.wipe"] } as Genome;
    const r = staticChecks(bad, { existing: [] });
    expect(r.reasons).toContain("forbidden: 'governor.pause'");
    expect(r.reasons).toContain("forbidden: 'audit.wipe'");
    expect(r.reasons.some((x) => x.startsWith("tier: 'http.get'"))).toBe(true);
    expect(r.reasons).toContain("tools: unknown tool 'nope.tool'");
    expect(r.reasons.some((x) => x.includes("unknown tool 'governor.pause'"))).toBe(false);
  });
  it("enforces size limits (configurable, never above the constitution)", async () => {
    const p = await make("builder", { tool_ids: ["think", "memory.write"] });
    const c = await tool_add(p, "sandbox.eval", ctx);
    const r = staticChecks(c, { existing: [p], maxPromptChars: 50, maxTools: 2 });
    expect(r.reasons.some((x) => x.startsWith("size: system_prompt"))).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("size:") && x.includes("tools"))).toBe(true);
    const huge = { ...p, system_prompt: "z".repeat(9000) } as Genome;
    expect(staticChecks(huge, { existing: [], maxPromptChars: 1e9 }).reasons.some((x) => x.startsWith("size: system_prompt"))).toBe(true);
  });
  it("checks lineage consistency with the parent", async () => {
    const p = await make("builder");
    const other = await make("researcher");
    const c = await strategy_swap(p, mulberry32(2), ctx);
    expect(staticChecks(c, { existing: [], parent: other }).reasons.some((x) => x.includes("does not list the parent"))).toBe(true);
    const roleHop = { ...c, role: "director" } as Genome;
    expect(staticChecks(roleHop, { existing: [], parent: p }).reasons.some((x) => x.includes("role change"))).toBe(true);
    const old = { ...c, version: p.version } as Genome;
    expect(staticChecks(old, { existing: [], parent: p }).reasons.some((x) => x.includes("must exceed parent"))).toBe(true);
  });
  it("allows a spawned new lineage but not a lineage-id collision", async () => {
    const t = await make("researcher");
    // a bare rename is a near-duplicate of its template; a specialised prompt passes
    const bare = await spawn_role(t, "Market Researcher", ctx);
    const rb = staticChecks(bare, { existing: [t], parent: t, proposerRole: "architect" });
    expect(rb.pass).toBe(false);
    expect(rb.reasons.every((x) => x.startsWith("novelty:"))).toBe(true);
    const s = await spawn_role(t, "Market Researcher", ctx, {
      prompt: "You are the Market Researcher. Size markets, list competitors with sources, and flag every assumption you make.",
    });
    const rs = staticChecks(s, { existing: [t], parent: t, proposerRole: "architect" });
    expect(rs.reasons).toEqual([]);
    const clash = await spawn_role(t, "Builder", ctx, { lineageId: "builder" });
    const b = await make("builder");
    const r = staticChecks(clash, { existing: [t, b], parent: t });
    expect(r.reasons.some((x) => x.includes("already exists"))).toBe(true);
  });
  describe("protected lineages", () => {
    it("evaluator/critic/auditor cannot propose their own role's lineage", async () => {
      for (const role of ["evaluator", "critic", "auditor"] as const) {
        const p = await make(role);
        const c = await strategy_swap(p, mulberry32(4), ctx);
        expect(isProtectedLineage(c)).toBe(true);
        const r = staticChecks(c, { existing: [p], parent: p, proposerRole: role });
        expect(r.pass).toBe(false);
        expect(r.reasons.some((x) => x.startsWith("protected:"))).toBe(true);
        expect(staticChecks(c, { existing: [p], parent: p, proposerRole: "architect" }).pass).toBe(true);
      }
    });
    it("a protected lineage cannot propose its own successor via lineage id", async () => {
      const p = await make("critic");
      const c = await strategy_swap(p, mulberry32(4), ctx);
      const r = staticChecks(c, { existing: [p], parent: p, proposerRole: "architect", proposerLineageId: "critic" });
      expect(r.reasons.some((x) => x.includes("its own successor"))).toBe(true);
    });
    it("an agent judged by the lineage cannot propose changes to it", async () => {
      const p = await make("evaluator");
      const c = await strategy_swap(p, mulberry32(5), ctx);
      const r = staticChecks(c, {
        existing: [p],
        parent: p,
        proposerRole: "builder",
        proposerAgentId: "agent-builder-7",
        judgedIds: ["agent-builder-7"],
      });
      expect(r.reasons.some((x) => x.includes("judged by evaluator"))).toBe(true);
      const ok = staticChecks(c, { existing: [p], parent: p, proposerRole: "builder", proposerAgentId: "agent-x", judgedIds: ["agent-builder-7"] });
      expect(ok.pass).toBe(true);
    });
    it("non-protected lineages are unrestricted by proposer role", async () => {
      const p = await make("builder");
      const c = await strategy_swap(p, mulberry32(4), ctx);
      expect(isProtectedLineage(c)).toBe(false);
      expect(staticChecks(c, { existing: [p], parent: p, proposerRole: "builder" }).pass).toBe(true);
    });
  });
});

describe("canJudge (self-evaluation guard)", () => {
  it("forbids judging own genome, own lineage, own child, own authorship", async () => {
    const p = await make("builder");
    const c = await strategy_swap(p, mulberry32(1), { at: AT, by: "agent:b1" });
    expect(canJudge({ id: "e1", lineage_id: "evaluator", genome_id: "g_eval" }, c)).toBe(true);
    expect(canJudge({ id: "b2", lineage_id: "builder" }, c)).toBe(false);
    expect(canJudge({ id: "x", lineage_id: "other", genome_id: c.id }, c)).toBe(false);
    expect(canJudge({ id: "x", lineage_id: "other", genome_id: p.id }, c)).toBe(false);
    expect(canJudge({ id: "b1", lineage_id: "other" }, c)).toBe(false);
    expect(judgeConflicts({ id: "b1", lineage_id: "builder", genome_id: p.id }, c)).toHaveLength(3);
  });
});
