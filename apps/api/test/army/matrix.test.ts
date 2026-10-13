import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { ACTION_CLASSES, APPROVAL_MATRIX, AUTONOMY_LADDER, checkApprovals, matrixTable, requiredApprovals, RISK_TIERS, TWO_KEY_CLASSES, type ApprovalKey } from "../../src/army/autonomy";
import { DIVISIONS, divisionForRole, effectiveTierCap } from "../../src/army/divisions";
import { evaluateRank, getRankRow, recordIncident, reviewRank, type RankMetrics } from "../../src/army/ranks";
import { mintCapability, useCapability } from "../../src/army/capability";
import { issuePassport, verifyPassport } from "../../src/army/passport";
import { ROLES } from "../../src/constitution";
import { seedStarterOrg } from "../../src/registry/seed";
import { freshState } from "../helpers";

const E = env as Env;

const owner = (step_up = true): ApprovalKey => ({ approver: "owner", by: "owner", step_up });

describe("approval matrix: two-key rule", () => {
  it("money, publish, external_comms, data_export are two-key at every valid tier and never auto (even L5)", () => {
    for (const cls of TWO_KEY_CLASSES)
      for (const r of RISK_TIERS) {
        const req = requiredApprovals(cls, r, "L5", { inL5Contract: true });
        if (req.decision === "forbidden") continue;
        expect(req.decision).toBe("needs_approval");
        expect(req.two_key).toBe(true);
        expect(req.approvers).toContain("owner");
        expect(req.approvers.length).toBeGreaterThanOrEqual(2);
      }
  });

  it("owner alone, or a second key alone, never satisfies two-key", () => {
    const req = requiredApprovals("money", 4, "L4");
    expect(checkApprovals(req, [owner()]).satisfied).toBe(false);
    expect(checkApprovals(req, [{ approver: "security_council", by: "sec-1" }]).satisfied).toBe(false);
    expect(checkApprovals(req, [owner(false), { approver: "security_council", by: "sec-1" }]).missing).toContain("owner step-up (TOTP)");
    expect(checkApprovals(req, [owner(), { approver: "security_council", by: "sec-1" }]).satisfied).toBe(true);
  });

  it("second key must not come from the requester, the owner, or the requester's division", () => {
    const req = requiredApprovals("publish", 4, "L4");
    const requester = { id: "a_fin", division: "finance" };
    expect(checkApprovals(req, [owner(), { approver: "security_council", by: "a_fin", division: "security" }], requester).satisfied).toBe(false);
    expect(checkApprovals(req, [owner(), { approver: "security_council", by: "owner" }], requester).satisfied).toBe(false);
    expect(checkApprovals(req, [owner(), { approver: "security_council", by: "sec-2", division: "finance" }], requester).satisfied).toBe(false);
    expect(checkApprovals(req, [owner(), { approver: "court", by: "judge-1", division: "quality" }], requester).satisfied).toBe(false); // court is not a listed second key for publish R4
    expect(checkApprovals(req, [owner(), { approver: "security_council", by: "sec-2", division: "security" }], requester).satisfied).toBe(true);
  });

  it("R3 external comms: owner + court, no step-up needed; R4: step-up needed", () => {
    const r3 = requiredApprovals("external_comms", 3, "L4");
    expect(r3.step_up).toBe(false);
    expect(checkApprovals(r3, [owner(false), { approver: "court", by: "legal-1" }]).satisfied).toBe(true);
    const r4 = requiredApprovals("external_comms", 4, "L4");
    expect(checkApprovals(r4, [owner(false), { approver: "court", by: "legal-1" }]).satisfied).toBe(false);
  });

  it("core_change is forbidden everywhere (golden rule), invalid cells are forbidden", () => {
    for (const r of RISK_TIERS) for (const l of AUTONOMY_LADDER) expect(requiredApprovals("core_change", r, l.level, { inL5Contract: true }).decision).toBe("forbidden");
    expect(requiredApprovals("money", 2, "L4").decision).toBe("forbidden");
    expect(checkApprovals(requiredApprovals("core_change", 4, "L5"), [owner(), { approver: "court", by: "x" }]).satisfied).toBe(false);
  });

  it("auto cells depend on the level; L5 contract makes non-two-key approvals auto", () => {
    expect(requiredApprovals("think_memory", 0, "L0").decision).toBe("auto");
    expect(requiredApprovals("sandbox_code", 0, "L1").decision).toBe("needs_approval");
    expect(requiredApprovals("sandbox_code", 0, "L2").decision).toBe("auto");
    expect(requiredApprovals("customer_reply", 2, "L2").decision).toBe("needs_approval");
    expect(requiredApprovals("customer_reply", 2, "L3").decision).toBe("auto");
    expect(requiredApprovals("evolution", 3, "L5", { inL5Contract: true }).decision).toBe("auto");
    const beyond = requiredApprovals("evolution", 3, "L2");
    expect(beyond.approvers).toContain("owner");
    expect(checkApprovals(beyond, [{ approver: "security_council", by: "s" }]).satisfied).toBe(false);
    expect(checkApprovals(beyond, [owner(false)]).satisfied).toBe(true);
  });

  it("matrix is frozen and complete", () => {
    expect(Object.isFrozen(APPROVAL_MATRIX)).toBe(true);
    expect(() => {
      (APPROVAL_MATRIX as any).money[4] = { approvers: ["auto"] };
    }).toThrow();
    const t = matrixTable();
    expect(t.length).toBe(ACTION_CLASSES.length);
    expect(t.every((r) => r.cells.length === 5)).toBe(true);
    expect(AUTONOMY_LADDER.map((r) => r.level)).toEqual(["L0", "L1", "L2", "L3", "L4", "L5"]);
    expect(AUTONOMY_LADDER[5].owner_only).toBe(true);
  });
});

describe("divisions and ranks", () => {
  it("9 divisions; every constitutional role maps to one; tier caps never exceed the constitution", () => {
    expect(DIVISIONS.length).toBe(9);
    for (const r of ROLES) expect(DIVISIONS.map((d) => d.id)).toContain(divisionForRole(r));
    expect(divisionForRole("evaluator")).toBe("quality");
    expect(divisionForRole("operator")).toBe("operators");
    expect(effectiveTierCap("director", "operators")).toBe(2); // director T4 lowered by the division cap
    expect(effectiveTierCap("architect", "builders")).toBe(1); // constitution cap wins
  });

  const base: RankMetrics = { rating: 1500, rd: 200, matches: 0, eval_pass_rate: null, redteam_pass_rate: null, court_score: null, security_incidents: 0, days_since_incident: null, canary_rollbacks_7d: 0, honeypot_7d: 0, weak_verdicts_7d: 0, critical_7d: 0, owner_accepted: false };

  it("promotes one rank per review by Elo / RD / missions / eval / red-team / court", () => {
    expect(evaluateRank("R0", base).change).toBe("hold");
    const r1m = { ...base, rating: 1560, rd: 100, matches: 30, eval_pass_rate: 0.8 };
    expect(evaluateRank("R0", r1m)).toMatchObject({ change: "promote", next: "R1" });
    expect(evaluateRank("R0", { ...r1m, security_incidents: 1 }).change).toBe("hold");
    const r2m = { ...r1m, rating: 1700, redteam_pass_rate: 0.98, court_score: 0.85 };
    expect(evaluateRank("R0", r2m)).toMatchObject({ change: "promote", next: "R1", eligible: "R2" });
    expect(evaluateRank("R1", r2m)).toMatchObject({ change: "promote", next: "R2" });
    expect(evaluateRank("R1", { ...r2m, redteam_pass_rate: 0.96 }).change).toBe("hold");
    const r3m = { ...r2m, rating: 1800, days_since_incident: 120 };
    expect(evaluateRank("R2", r3m).missing).toContain("owner acceptance");
    expect(evaluateRank("R2", { ...r3m, owner_accepted: true })).toMatchObject({ change: "promote", next: "R3" });
    expect(evaluateRank("R3", { ...r3m, owner_accepted: true }).change).toBe("hold"); // never auto R4
  });

  it("demotes on incidents (critical → R0), R4 included", () => {
    expect(evaluateRank("R2", { ...base, canary_rollbacks_7d: 1 })).toMatchObject({ change: "demote", next: "R1" });
    expect(evaluateRank("R2", { ...base, weak_verdicts_7d: 3 })).toMatchObject({ change: "demote", next: "R1" });
    expect(evaluateRank("R2", { ...base, weak_verdicts_7d: 2 }).change).toBe("hold");
    expect(evaluateRank("R3", { ...base, critical_7d: 1 })).toMatchObject({ change: "demote", next: "R0" });
    expect(evaluateRank("R4", { ...base, honeypot_7d: 1 })).toMatchObject({ change: "demote", next: "R3" });
  });
});

describe("rank reviews in D1", () => {
  beforeEach(async () => {
    await freshState();
    await seedStarterOrg(E, "owner");
  });

  it("an incident demotes the agent and revokes its passports and capabilities", async () => {
    await getRankRow(E, "a_builder");
    await E.DB.prepare("UPDATE army_ranks SET rank = 'R2' WHERE agent_id = 'a_builder'").run();
    const pp = await issuePassport(E, "a_builder");
    const cap = await mintCapability(E, { agent_id: "a_builder", tools: ["think"], max_tier: 0 });
    await recordIncident(E, "a_builder", "canary_rollback", 2);
    const r = await reviewRank(E, "a_builder");
    expect(r).toMatchObject({ change: "demote", next: "R1" });
    expect(r.revoked).toEqual({ capabilities: 1, passports: 1 });
    expect(await verifyPassport(E, pp.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect((await useCapability(E, cap.token, { tool_id: "think", tier: 0 })).ok).toBe(false);
  });

  it("promotion reads Elo + runs from existing tables (metrics override for court/redteam)", async () => {
    const g = await E.DB.prepare("SELECT genome_id FROM agents WHERE id = 'a_researcher'").first<{ genome_id: string }>();
    await E.DB.prepare("UPDATE elo_ratings SET rating = 1600, rd = 90, matches = 40 WHERE genome_id = ?1").bind(g!.genome_id).run();
    await E.DB.prepare("INSERT INTO evals (id, genome_id, suite, score, created_at) VALUES ('e1', ?1, 's', 0.9, ?2)").bind(g!.genome_id, Date.now()).run();
    const r = await reviewRank(E, "a_researcher");
    expect(r).toMatchObject({ change: "promote", next: "R1", division: "researchers" });
    expect((await getRankRow(E, "a_researcher"))?.rank).toBe("R1");
    // A capability above the agent's tier ceiling is refused (researcher T3, division cap T3; builder T2).
    await expect(mintCapability(E, { agent_id: "a_builder", tools: ["http.get"], max_tier: 3 })).resolves.toBeTruthy(); // no rank row yet → no army ceiling
    await getRankRow(E, "a_builder");
    await expect(mintCapability(E, { agent_id: "a_builder", tools: ["http.get"], max_tier: 3 })).rejects.toMatchObject({ code: "tier_cap" });
  });
});
