import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { b64url, b64urlDecode, signDoc, verifyDoc } from "../../src/army/crypto";
import { issuePassport, listPassports, PassportError, revokePassport, signPassport, verifyPassport, verifyPassportSig, type PassportBody } from "../../src/army/passport";
import { ownerSetRank } from "../../src/army/ranks";
import { seedStarterOrg } from "../../src/registry/seed";
import { freshState } from "../helpers";

const E = env as Env;
beforeEach(async () => {
  await freshState();
  await seedStarterOrg(E, "owner");
});

const body = (over: Partial<PassportBody> = {}): PassportBody => ({
  v: 1,
  passport_id: "pp_test",
  agent_id: "a_builder",
  genome_id: "g_x",
  genome_hash: "h".repeat(64),
  lineage: { lineage_id: "l_x", parent_ids: [], version: 1 },
  rank: "R0",
  division: "builders",
  autonomy: "L1",
  redteam_score: null,
  iat: Date.now(),
  exp: Date.now() + 60_000,
  ...over,
});

describe("army passports: sign / verify / tamper", () => {
  it("signs and verifies with SESSION_SECRET; a different secret or purpose fails", async () => {
    const tok = await signPassport(E.SESSION_SECRET, body());
    expect(tok.startsWith("kp1.")).toBe(true);
    const v = await verifyPassportSig(E.SESSION_SECRET, tok);
    expect(v.ok).toBe(true);
    expect((await verifyPassportSig("another-secret-0123456789abcdef", tok)).ok).toBe(false);
    // Domain separation: a capability-purpose signature over the same body must not verify as a passport.
    const capSigned = await signDoc(E.SESSION_SECRET, "capability", "kp1", body());
    expect((await verifyPassportSig(E.SESSION_SECRET, capSigned)).ok).toBe(false);
    await expect(verifyDoc(E.SESSION_SECRET, "passport", "kp1", "kp1.only-two")).rejects.toThrow();
    await expect(signPassport("short", body())).rejects.toThrow(/SESSION_SECRET/);
  });

  it("detects tampering with the body (rank / autonomy edits) and with the signature", async () => {
    const tok = await signPassport(E.SESSION_SECRET, body());
    const [p, b, s] = tok.split(".");
    const decoded = JSON.parse(new TextDecoder().decode(b64urlDecode(b)));
    decoded.rank = "R4";
    decoded.autonomy = "L4";
    const forged = `${p}.${b64url(new TextEncoder().encode(JSON.stringify(decoded)))}.${s}`;
    const v1 = await verifyPassportSig(E.SESSION_SECRET, forged);
    expect(v1).toMatchObject({ ok: false, reason: "bad_signature" });
    const flipped = `${p}.${b}.${s.slice(0, -2)}${s.endsWith("AA") ? "AB" : "AA"}`;
    expect((await verifyPassportSig(E.SESSION_SECRET, flipped)).ok).toBe(false);
  });

  it("rejects expired passports", async () => {
    const tok = await signPassport(E.SESSION_SECRET, body({ iat: Date.now() - 10_000, exp: Date.now() - 1 }));
    expect(await verifyPassportSig(E.SESSION_SECRET, tok)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("issues for a real agent (rank-capped autonomy, genome hash, lineage), verifies, revokes", async () => {
    const { token, passport } = await issuePassport(E, "a_builder", { autonomy: "L4" });
    expect(passport.rank).toBe("R0");
    expect(passport.autonomy).toBe("L1"); // R0 ceiling
    expect(passport.division).toBe("builders");
    expect(passport.genome_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(passport.lineage.lineage_id).toBeTruthy();
    expect(passport.exp - passport.iat).toBe(30 * 86_400_000);
    expect((await verifyPassport(E, token)).ok).toBe(true);

    expect(await revokePassport(E, passport.passport_id, "test")).toBe(true);
    expect(await verifyPassport(E, token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(await revokePassport(E, passport.passport_id, "again")).toBe(false);
  });

  it("supersedes older passports, never carries L5, follows the rank ceiling", async () => {
    const a = await issuePassport(E, "a_researcher");
    await ownerSetRank(E, "a_researcher", { rank: "R2" }, "owner");
    const b = await issuePassport(E, "a_researcher");
    expect(b.passport.autonomy).toBe("L3");
    expect(await verifyPassport(E, a.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect((await verifyPassport(E, b.token)).ok).toBe(true);
    await expect(issuePassport(E, "a_researcher", { autonomy: "L5" })).rejects.toBeInstanceOf(PassportError);
    await expect(issuePassport(E, "nobody")).rejects.toMatchObject({ code: "not_found" });
    expect((await listPassports(E, { agent_id: "a_researcher", live: true })).length).toBe(1);
  });

  it("an unknown (never issued) but validly signed passport is rejected by full verification", async () => {
    const tok = await signPassport(E.SESSION_SECRET, body());
    expect(await verifyPassport(E, tok)).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("detects a genome swap after issue", async () => {
    const { token } = await issuePassport(E, "a_builder");
    const other = await E.DB.prepare("SELECT genome_id FROM agents WHERE id = 'a_researcher'").first<{ genome_id: string }>();
    await E.DB.prepare("UPDATE agents SET genome_id = ?1 WHERE id = 'a_builder'").bind(other!.genome_id).run();
    expect(await verifyPassport(E, token)).toMatchObject({ ok: false, reason: "genome_changed" });
  });
});
