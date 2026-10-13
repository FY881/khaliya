import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from "../src/auth/totp";
import { signSession, verifySession } from "../src/auth/session";
import { api, codeAt, freshState, login } from "./helpers";

beforeEach(freshState);

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 6238 SHA-1 test vectors", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    // RFC 6238 Appendix B (8 digits) → we check the last 6 digits.
    expect(await totp(secret, 59_000, 8)).toBe("94287082");
    expect(await totp(secret, 1111111109_000, 8)).toBe("07081804");
    expect(await totp(secret, 20000000000_000, 8)).toBe("65353130");
  });
  it("RFC 4226 HOTP vectors and base32 round-trip", async () => {
    const key = new TextEncoder().encode("12345678901234567890");
    expect(await hotp(key, 0)).toBe("755224");
    expect(await hotp(key, 9)).toBe("520489");
    expect(new TextDecoder().decode(base32Decode(base32Encode(key)))).toBe("12345678901234567890");
  });
  it("accepts ±1 step and rejects others", async () => {
    const s = "JBSWY3DPEHPK3PXP";
    const t = 1_700_000_000_000;
    expect(await verifyTotp(s, await totp(s, t - 30_000), t)).not.toBeNull();
    expect(await verifyTotp(s, await totp(s, t - 90_000), t)).toBeNull();
    expect(await verifyTotp(s, "abc123", t)).toBeNull();
  });
});

describe("signed session cookie", () => {
  it("verifies, rejects tampering, expiry and revoked epoch", async () => {
    const tok = await signSession("secret-secret-secret", 0, 1000);
    expect(await verifySession("secret-secret-secret", tok, 0, 1001)).toMatchObject({ sub: "owner" });
    expect(await verifySession("other-secret-secret!", tok, 0, 1001)).toBeNull();
    expect(await verifySession("secret-secret-secret", tok.slice(0, -2) + "xx", 0, 1001)).toBeNull();
    expect(await verifySession("secret-secret-secret", tok, 0, 1000 + 13 * 3600)).toBeNull();
    expect(await verifySession("secret-secret-secret", tok, 1, 1001)).toBeNull();
  });
});

describe("owner-only API", () => {
  it("health is public; everything else needs the owner session", async () => {
    expect((await SELF.fetch("https://k.test/api/health")).status).toBe(200);
    expect((await SELF.fetch("https://k.test/api/agents")).status).toBe(401);
    expect((await SELF.fetch("https://k.test/api/approvals")).status).toBe(401);
    const forged = await SELF.fetch("https://k.test/api/agents", { headers: { cookie: "khaliya_session=eyJzdWIiOiJvd25lciJ9.AAAA" } });
    expect(forged.status).toBe(401);
  });

  it("there is no signup route", async () => {
    const r = await SELF.fetch("https://k.test/api/auth/signup", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("wrong code → 401; correct code → HttpOnly Secure SameSite cookie", async () => {
    const bad = await SELF.fetch("https://k.test/api/auth/login", { method: "POST", body: JSON.stringify({ code: "000000" }) });
    expect(bad.status).toBe(401);
    const ok = await SELF.fetch("https://k.test/api/auth/login", { method: "POST", body: JSON.stringify({ code: await codeAt(0) }) });
    expect(ok.status).toBe(200);
    const set = ok.headers.get("set-cookie")!;
    expect(set).toMatch(/khaliya_session=/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Strict/);
    const me = await api(set.split(";")[0], "/api/auth/me");
    expect(me.status).toBe(200);
  });

  it("a TOTP code cannot be replayed", async () => {
    const code = await codeAt(0);
    const first = await SELF.fetch("https://k.test/api/auth/login", { method: "POST", body: JSON.stringify({ code }) });
    expect(first.status).toBe(200);
    const again = await SELF.fetch("https://k.test/api/auth/login", { method: "POST", body: JSON.stringify({ code }) });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: "code already used" });
  });

  it("locks out after 5 failed attempts", async () => {
    for (let i = 0; i < 5; i++) await SELF.fetch("https://k.test/api/auth/login", { method: "POST", body: JSON.stringify({ code: "111111" }) });
    const r = await SELF.fetch("https://k.test/api/auth/login", { method: "POST", body: JSON.stringify({ code: await codeAt(0) }) });
    expect(r.status).toBe(423);
  });

  it("mutations require the x-khaliya CSRF header", async () => {
    const cookie = await login();
    const r = await SELF.fetch("https://k.test/api/governor/kill", { method: "POST", headers: { cookie }, body: JSON.stringify({ on: true }) });
    expect(r.status).toBe(403);
  });

  it("logout-all revokes existing sessions", async () => {
    const cookie = await login();
    expect((await api(cookie, "/api/auth/logout-all", { method: "POST" })).status).toBe(200);
    expect((await api(cookie, "/api/auth/me")).status).toBe(401);
  });

  it("never returns provider keys from settings", async () => {
    const cookie = await login();
    const s = await api(cookie, "/api/settings");
    expect(s.status).toBe(200);
    expect(s.text).not.toContain(env.SESSION_SECRET!);
    expect(s.text).not.toContain(env.OWNER_TOTP_SECRET!);
  });
});
