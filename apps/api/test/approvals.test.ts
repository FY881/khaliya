import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalError, createApproval, decideApproval } from "../src/approvals";
import { TOOLS } from "../src/tools/catalog";
import { seedStarterOrg } from "../src/registry/seed";
import { api, codeAt, freshState, login } from "./helpers";

beforeEach(async () => {
  await freshState();
  await seedStarterOrg(env);
});

async function pending(tool: string, tier: 3 | 4, args: Record<string, unknown>) {
  return createApproval(env.DB, { agent_id: "a_director", run_id: null, tool_id: tool, tier, args, reason: "test" });
}

describe("approval queue", () => {
  it("no agent-callable tool can approve, reject or touch the governor", () => {
    for (const t of TOOLS) expect(t.id).not.toMatch(/^(approval|governor|constitution|audit|auth|budget|kill)\./);
  });

  it("only the owner actor can decide", async () => {
    const id = await pending("web.publish", 4, { target: "x", content: "y" });
    await expect(decideApproval(env, id, "approve", { actor: "agent:a_director", stepUpOk: true })).rejects.toBeInstanceOf(ApprovalError);
  });

  it("approvals API is behind owner auth", async () => {
    const r = await api("", "/api/approvals");
    expect(r.status).toBe(401);
    const d = await api("", "/api/approvals/apr_x/approve", { method: "POST", body: {} });
    expect(d.status).toBe(401);
  });

  it("owner approves a T4 request with step-up; it executes once and the agent is notified", async () => {
    const id = await pending("email.send", 4, { to: "a@b.c", subject: "s", body: "b" });
    const cookie = await login(-1);
    const list = await api(cookie, "/api/approvals?status=pending");
    expect(list.json.approvals.map((a: any) => a.id)).toContain(id);

    const noStepUp = await api(cookie, `/api/approvals/${id}/approve`, { method: "POST", body: {} });
    expect(noStepUp.status).toBe(428);

    const ok = await api(cookie, `/api/approvals/${id}/approve`, { method: "POST", body: { code: await codeAt(1) } });
    expect(ok.status).toBe(200);
    expect(ok.json.approval.status).toBe("executed");
    expect(JSON.parse(ok.json.approval.result).effect).toBe("none"); // P1: no external effect

    const twice = await api(cookie, `/api/approvals/${id}/approve`, { method: "POST", body: {} });
    expect(twice.status).toBe(409);

    const desk = await api(cookie, "/api/agents/a_director/desk");
    expect(desk.json.inbox[0].text).toContain(id);
  });

  it("owner can reject; a rejected request never executes", async () => {
    const id = await pending("http.get", 3, { url: "https://example.com" });
    const cookie = await login();
    const r = await api(cookie, `/api/approvals/${id}/reject`, { method: "POST", body: { note: "not now" } });
    expect(r.json.approval.status).toBe("rejected");
    const audit = await api(cookie, "/api/audit?limit=20");
    expect(audit.json.entries.some((e: any) => e.action === "approval.rejected" && e.target === id)).toBe(true);
    expect(audit.json.entries.some((e: any) => e.action === "approval.executed")).toBe(false);
  });
});
