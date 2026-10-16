import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_MAX_FAILS, ipFailKey, MAX_FAILS } from "../../src/auth/owner";
import { Governor } from "../../src/governor/governor";
import { BODY_LIMITS, CONSOLE_CSP } from "../../src/security";
import { api, codeAt, freshState, login } from "../helpers";

beforeEach(freshState);

const loginFrom = async (ip: string, code: string) =>
  SELF.fetch("https://k.test/api/auth/login", { method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/json" }, body: JSON.stringify({ code }) });

describe("/api/health", () => {
  it("reports services_public false", async () => {
    const r = await SELF.fetch("https://k.test/api/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, services_public: false });
  });
});

describe("login lockout per IP + global ceiling", () => {
  it("5 failures lock that IP only; another IP can still log in", async () => {
    for (let i = 0; i < MAX_FAILS; i++) expect((await loginFrom("203.0.113.7", "111111")).status).toBe(401);
    expect((await loginFrom("203.0.113.7", await codeAt(0))).status).toBe(423);
    expect((await loginFrom("198.51.100.20", await codeAt(0))).status).toBe(200);
  });
  it("the global ceiling locks everyone", async () => {
    await new Governor(env).setState("auth.fails", JSON.stringify({ n: GLOBAL_MAX_FAILS, since: Date.now() }));
    expect((await loginFrom("198.51.100.21", await codeAt(0))).status).toBe(423);
  });
  it("the IP is stored hashed, never raw", async () => {
    await loginFrom("203.0.113.9", "111111");
    const key = await ipFailKey("203.0.113.9");
    expect(key).not.toContain("203.0.113.9");
    expect(JSON.parse((await new Governor(env).getState(key))!)).toMatchObject({ n: 1 });
  });
  it("a success resets that IP's counter", async () => {
    for (let i = 0; i < MAX_FAILS - 1; i++) await loginFrom("203.0.113.10", "111111");
    expect((await loginFrom("203.0.113.10", await codeAt(0))).status).toBe(200);
    expect(JSON.parse((await new Governor(env).getState(await ipFailKey("203.0.113.10")))!)).toMatchObject({ n: 0 });
  });
});

describe("body size cap", () => {
  it("413 above the default cap on an owner route", async () => {
    const cookie = await login();
    const big = "x".repeat(BODY_LIMITS.default + 10);
    const r = await SELF.fetch("https://k.test/api/agents", { method: "POST", headers: { cookie, "x-khaliya": "1", "content-type": "application/json" }, body: JSON.stringify({ genome: { name: big } }) });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: "payload too large", max_bytes: BODY_LIMITS.default });
  });
  it("login bodies are capped small (before any auth work)", async () => {
    const r = await SELF.fetch("https://k.test/api/auth/login", { method: "POST", body: JSON.stringify({ code: "1".repeat(BODY_LIMITS.login + 1) }) });
    expect(r.status).toBe(413);
  });
  it("normal bodies pass", async () => {
    const cookie = await login();
    expect((await api(cookie, "/api/governor/kill", { method: "POST", body: { on: false } })).status).toBe(200);
  });
});

describe("security headers", () => {
  it("API responses carry restrictive defaults", async () => {
    const r = await SELF.fetch("https://k.test/api/health");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=31536000/);
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
  });
  it("console responses carry the CSP (no inline scripts)", async () => {
    const r = await SELF.fetch("https://k.test/some/console/page");
    expect(r.headers.get("content-security-policy")).toBe(CONSOLE_CSP);
    expect(CONSOLE_CSP).toMatch(/script-src 'self'(;|$)/);
    expect(CONSOLE_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=/);
  });
});
