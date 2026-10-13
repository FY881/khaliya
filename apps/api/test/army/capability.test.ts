import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { buildCapabilityBody, checkCapability, mintCapability, narrowerThan, revocationList, revokeCapability, useCapability, type CapabilityBody } from "../../src/army/capability";
import { freshState } from "../helpers";

const E = env as Env;
beforeEach(freshState);

const T0 = 1_800_000_000_000;
const tok = (over: Partial<CapabilityBody> = {}): CapabilityBody => ({
  ...buildCapabilityBody({ agent_id: "agent-1", mission_id: "m1", tools: ["kb.read", "forge.text.*"], max_tier: 2, data_scopes: ["tenant:a"], egress: ["api.github.com", "*.example.org"], ttl_s: 900, max_calls: 3 }, T0),
  ...over,
});

describe("checkCapability (pure): scope", () => {
  it("allows in-scope tools (exact and prefix.*) and denies others", () => {
    const t = tok();
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1 }, { now: T0 + 1 })).toEqual({ ok: true });
    expect(checkCapability(t, { tool_id: "forge.text.slugify", tier: 2 }, { now: T0 + 1 })).toEqual({ ok: true });
    expect(checkCapability(t, { tool_id: "forge.textx", tier: 1 }, { now: T0 + 1 })).toMatchObject({ ok: false, reason: "tool_not_allowed", violation: true });
    expect(checkCapability(t, { tool_id: "email.send", tier: 4 }, { now: T0 + 1 })).toMatchObject({ ok: false, reason: "tool_not_allowed" });
    expect(checkCapability(t, { tool_id: "governor.set", tier: 0 }, { now: T0 + 1 })).toMatchObject({ ok: false, reason: "forbidden_capability" });
  });
  it("enforces tiers, data scopes, egress, agent and mission binding", () => {
    const t = tok({ tiers: [1] });
    expect(checkCapability(t, { tool_id: "kb.read", tier: 3 }, { now: T0 })).toMatchObject({ reason: "tier_exceeded" });
    expect(checkCapability(t, { tool_id: "kb.read", tier: 2 }, { now: T0 })).toMatchObject({ reason: "tier_not_allowed" });
    const u = tok();
    expect(checkCapability(u, { tool_id: "kb.read", tier: 1, data_scope: "tenant:b" }, { now: T0 })).toMatchObject({ reason: "data_scope_denied" });
    expect(checkCapability(u, { tool_id: "kb.read", tier: 1, data_scope: "tenant:a" }, { now: T0 }).ok).toBe(true);
    expect(checkCapability(u, { tool_id: "kb.read", tier: 1, egress_domain: "evil.com" }, { now: T0 })).toMatchObject({ reason: "egress_denied" });
    expect(checkCapability(u, { tool_id: "kb.read", tier: 1, egress_domain: "docs.example.org" }, { now: T0 }).ok).toBe(true);
    expect(checkCapability(u, { tool_id: "kb.read", tier: 1, egress_domain: "example.org.evil.com" }, { now: T0 }).ok).toBe(false);
    expect(checkCapability(u, { tool_id: "kb.read", tier: 1, agent_id: "agent-2" }, { now: T0 })).toMatchObject({ reason: "wrong_agent" });
    expect(checkCapability(u, { tool_id: "kb.read", tier: 1, mission_id: "m2" }, { now: T0 })).toMatchObject({ reason: "wrong_mission" });
  });
});

describe("checkCapability (pure): expiry / calls / spend / revocation", () => {
  it("expires after TTL and is not valid before issue", () => {
    const t = tok();
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1 }, { now: T0 + 899_000 }).ok).toBe(true);
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1 }, { now: T0 + 900_000 })).toMatchObject({ reason: "expired", violation: false });
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1 }, { now: T0 - 60_000 })).toMatchObject({ reason: "not_yet_valid" });
  });
  it("caps calls and spend (default spend cap is 0)", () => {
    const t = tok();
    expect(t.spend_cap_usd).toBe(0);
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1 }, { now: T0, calls_used: 3 })).toMatchObject({ reason: "max_calls" });
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1, spend_usd: 0.01 }, { now: T0 })).toMatchObject({ reason: "spend_cap", violation: true });
    const s = tok({ spend_cap_usd: 5 });
    expect(checkCapability(s, { tool_id: "kb.read", tier: 1, spend_usd: 2 }, { now: T0, spent_usd: 3 }).ok).toBe(true);
    expect(checkCapability(s, { tool_id: "kb.read", tier: 1, spend_usd: 2.01 }, { now: T0, spent_usd: 3 })).toMatchObject({ reason: "spend_cap" });
  });
  it("honours the revocation list (token or its parent)", () => {
    const t = tok({ parent_id: "cap_parent" });
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1 }, { now: T0, revoked: [t.token_id] })).toMatchObject({ reason: "revoked" });
    expect(checkCapability(t, { tool_id: "kb.read", tier: 1 }, { now: T0, revoked: new Set(["cap_parent"]) })).toMatchObject({ reason: "revoked" });
  });
  it("validates specs: no wildcard-all, no forbidden prefixes, no '*' data scope, bounded ttl/calls", () => {
    expect(() => buildCapabilityBody({ agent_id: "a", tools: ["*"] })).toThrow();
    expect(() => buildCapabilityBody({ agent_id: "a", tools: ["audit.*"] })).toThrow(/forbidden/);
    expect(() => buildCapabilityBody({ agent_id: "a", tools: ["kill.agent"] })).toThrow(/forbidden/);
    expect(() => buildCapabilityBody({ agent_id: "a", tools: ["kb.read"], data_scopes: ["*"] })).toThrow();
    expect(() => buildCapabilityBody({ agent_id: "a", tools: ["kb.read"], ttl_s: 999_999 })).toThrow();
    expect(() => buildCapabilityBody({ agent_id: "a", tools: ["kb.read"], max_calls: 0 })).toThrow();
    expect(buildCapabilityBody({ agent_id: "a", tools: ["kb.read"] }, T0).exp).toBe(T0 + 900_000);
  });
  it("attenuation: children may only narrow", () => {
    const p = tok();
    const base = { ...p, parent_id: p.token_id };
    expect(narrowerThan({ ...base, tools: ["forge.text.upper"] }, p)).toEqual([]);
    expect(narrowerThan({ ...base, tools: ["forge.text.x.*"] }, p)).toEqual([]);
    expect(narrowerThan({ ...base, tools: ["forge.*"] }, p).length).toBe(1);
    expect(narrowerThan({ ...base, max_tier: 3 }, p)).toContain("max_tier wider than parent");
    expect(narrowerThan({ ...base, egress: ["a.example.org"] }, p)).toEqual([]);
    expect(narrowerThan({ ...base, egress: ["evil.com"] }, p).length).toBe(1);
    expect(narrowerThan({ ...base, exp: p.exp + 1 }, p)).toContain("outlives parent");
    expect(narrowerThan({ ...base, max_calls: 3 }, p, 1)).toContain("more calls than parent has left");
    expect(narrowerThan({ ...base, spend_cap_usd: 1 }, p)).toContain("spend cap above parent");
  });
});

describe("capability tokens in D1: mint / use / auto-revoke / two-key", () => {
  it("mints signed tokens, counts calls atomically, denies past max_calls", async () => {
    const { token, body } = await mintCapability(E, { agent_id: "agent-1", tools: ["kb.read"], max_tier: 1, max_calls: 2 });
    expect(token.startsWith("kc1.")).toBe(true);
    expect(body.spend_cap_usd).toBe(0);
    expect(await useCapability(E, token, { tool_id: "kb.read", tier: 1 })).toMatchObject({ ok: true, calls_used: 1 });
    expect(await useCapability(E, token, { tool_id: "kb.read", tier: 1 })).toMatchObject({ ok: true, calls_used: 2 });
    expect(await useCapability(E, token, { tool_id: "kb.read", tier: 1 })).toMatchObject({ ok: false, reason: "max_calls" });
    const forged = token.slice(0, -3) + (token.endsWith("abc") ? "abd" : "abc");
    expect((await useCapability(E, forged, { tool_id: "kb.read", tier: 1 })).ok).toBe(false);
  });

  it("out-of-scope use auto-revokes the token and its children and records an incident", async () => {
    const root = await mintCapability(E, { agent_id: "agent-1", mission_id: "m9", tools: ["kb.read", "think"], max_tier: 1, max_calls: 10 });
    const child = await mintCapability(E, { agent_id: "agent-2", mission_id: "m9", tools: ["think"], max_tier: 1, max_calls: 2 }, { parent: root.token });
    expect(child.body.parent_id).toBe(root.body.token_id);
    await expect(mintCapability(E, { agent_id: "agent-2", mission_id: "m9", tools: ["email.send"], max_tier: 1, max_calls: 2 }, { parent: root.token })).rejects.toMatchObject({ code: "not_narrower" });
    const r = await useCapability(E, root.token, { tool_id: "email.send", tier: 4 });
    expect(r).toMatchObject({ ok: false, reason: "tool_not_allowed", revoked: true });
    expect(await useCapability(E, root.token, { tool_id: "kb.read", tier: 1 })).toMatchObject({ ok: false, reason: "revoked" });
    expect(await useCapability(E, child.token, { tool_id: "think", tier: 0 })).toMatchObject({ ok: false, reason: "revoked" });
    const list = await revocationList(E);
    expect(list).toEqual(expect.arrayContaining([root.body.token_id, child.body.token_id]));
    const inc = await E.DB.prepare("SELECT kind FROM army_incidents WHERE agent_id = 'agent-1'").first<{ kind: string }>();
    expect(inc?.kind).toBe("scope_violation");
  });

  it("spend_cap_usd > 0 requires owner step-up + a second key from another division", async () => {
    const spec = { agent_id: "fin-1", tools: ["spend.request"], max_tier: 4 as const, spend_cap_usd: 5 };
    await expect(mintCapability(E, spec)).rejects.toMatchObject({ code: "two_key_required" });
    await expect(mintCapability(E, spec, { keys: [{ approver: "owner", by: "owner", step_up: true }] })).rejects.toMatchObject({ code: "two_key_required" });
    await expect(mintCapability(E, spec, { keys: [{ approver: "owner", by: "owner", step_up: false }, { approver: "security_council", by: "sec-1" }] })).rejects.toMatchObject({ code: "two_key_required" });
    const ok = await mintCapability(E, spec, { keys: [{ approver: "owner", by: "owner", step_up: true }, { approver: "security_council", by: "sec-1", division: "security" }] });
    expect(ok.body.spend_cap_usd).toBe(5);
  });

  it("manual revoke works and is idempotent", async () => {
    const { token, body } = await mintCapability(E, { agent_id: "agent-1", tools: ["kb.read"] });
    expect(await revokeCapability(E, body.token_id, "test")).toBe(1);
    expect(await revokeCapability(E, body.token_id, "test")).toBe(0);
    expect((await useCapability(E, token, { tool_id: "kb.read", tier: 1 })).ok).toBe(false);
  });
});
