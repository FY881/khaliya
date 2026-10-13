import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../../src/audit";
import type { Env } from "../../src/env";
import { admissionInit, admissionStep, evaluateTool } from "../../src/forge/admission";
import { mockForgeCritic } from "../../src/forge/jobs";
import { getToolByName, runsFor } from "../../src/forge/store";
import { Governor } from "../../src/governor/governor";
import { drainJob } from "../../src/jobs/runner";
import { getJob } from "../../src/jobs/store";
import { seedStarterOrg } from "../../src/registry/seed";
import type { MemoryStore } from "../../src/tools/catalog";
import { ToolGateway } from "../../src/tools/gateway";
import { api, freshState, login } from "../helpers";
import { approveCritic, slugifySpec } from "./fixtures";

const E = env as unknown as Env;
const T = 60_000;
beforeEach(freshState);

const mem = (): MemoryStore => ({ write: async () => ({ id: 1 }), search: async () => [] });
const ownerSpec = () => {
  const { author: _a, lineage: _l, ...rest } = slugifySpec();
  return rest;
};

async function submitAndDrain(cookie: string, spec: unknown = ownerSpec()) {
  const r = await api(cookie, "/api/forge/submit", { method: "POST", body: spec });
  expect(r.status).toBe(202);
  const job = await drainJob(E, r.json.job_id);
  return { r, job };
}

describe("forge admission as a resumable job", () => {
  it("the chunked cursor (1 sandbox run per step) gives the same report as the one-shot pipeline", async () => {
    const spec = slugifySpec();
    const deps = { critic: approveCritic(), fuzzCases: 6 };
    const one = await evaluateTool(spec, deps);
    const c = await admissionInit(spec);
    let steps = 0;
    while (c.phase !== "done" && steps < 200) {
      await admissionStep(spec, c, deps, 1);
      steps++;
    }
    expect(c.report!.status).toBe("admitted");
    expect(c.report!.gates.map((g) => [g.gate, g.pass, !!g.skipped])).toEqual(one.gates.map((g) => [g.gate, g.pass, !!g.skipped]));
    expect(c.report!.stats.runs).toBe(one.stats.runs);
    expect(steps).toBeGreaterThanOrEqual(one.stats.runs); // never more than one sandbox run per step
  });

  it("POST /api/forge/submit → 202 job; chunks drive it to admitted; list/detail/run/retire + events", { timeout: T }, async () => {
    const cookie = await login();
    const { r, job } = await submitAndDrain(cookie);
    expect(r.json).toMatchObject({ job_id: expect.any(String), poll: `/api/jobs/${r.json.job_id}`, tool: { name: "forge.text.slugify", status: "pending", version: 1 } });
    expect(job.status).toBe("done");
    expect(job.chunks).toBeGreaterThanOrEqual(7); // heavy: one gate / one run per chunk
    expect(job.result).toMatchObject({ status: "admitted", name: "forge.text.slugify" });

    const list = await api(cookie, "/api/forge/tools");
    expect(list.status).toBe(200);
    expect(list.json.counts.admitted).toBe(1);
    expect(list.json.tools[0]).toMatchObject({ name: "forge.text.slugify", status: "admitted", tier: 1, tests: 3, admitted_version: 1 });
    expect(list.json.tools[0].gates).toHaveLength(7);

    const det = await api(cookie, "/api/forge/tools/forge.text.slugify");
    expect(det.status).toBe(200);
    expect(det.json.tool.code).toContain("function run");
    expect(det.json.tests).toMatchObject({ total: 3, with_expect: 2, with_checker: 1 });
    expect(det.json.report.gates.every((g: any) => g.pass)).toBe(true);
    expect(det.json.job).toMatchObject({ kind: "forge.admit", status: "done" });
    expect(det.json.tool.effective_limits.fuel).toBeLessThanOrEqual(8); // FORGE_FUEL_CAP from wrangler.toml

    const run = await api(cookie, "/api/forge/tools/forge.text.slugify/run", { method: "POST", body: { input: { text: "Hello Hive" } } });
    expect(run.json).toMatchObject({ ok: true, value: { slug: "hello-hive" }, recorded: true, status: "admitted" });
    const bad = await api(cookie, "/api/forge/tools/forge.text.slugify/run", { method: "POST", body: { input: { nope: 1 } } });
    expect(bad.json).toMatchObject({ ok: false, error_kind: "invalid_args" });

    const ev = await api(cookie, "/api/hive/events?limit=100");
    const kinds = ev.json.events.map((e: any) => e.kind);
    expect(kinds).toContain("tool_admitted");
    expect(kinds).toContain("job_done");
    const adm = ev.json.events.find((e: any) => e.kind === "tool_admitted");
    expect(adm).toMatchObject({ severity: "success", announce: true, ref: { type: "tool", name: "forge.text.slugify" } });
    expect(adm.title_ar).toContain("forge.text.slugify");

    const ret = await api(cookie, "/api/forge/tools/forge.text.slugify/retire", { method: "POST", body: { reason: "test" } });
    expect(ret.json).toMatchObject({ ok: true, retired_versions: 1, tool: { status: "deprecated" } });
    expect((await api(cookie, "/api/forge/tools/forge.text.slugify/retire", { method: "POST", body: {} })).status).toBe(409);
    expect((await api(cookie, "/api/hive/events?limit=100")).json.events.map((e: any) => e.kind)).toContain("tool_retired");
  });

  it("structure problems → 422 without a row; identical spec → 200 duplicate; unknown tool → 404", { timeout: T }, async () => {
    const cookie = await login();
    const bad = await api(cookie, "/api/forge/submit", { method: "POST", body: { ...ownerSpec(), name: "governor.hack" } });
    expect(bad.status).toBe(422);
    expect(bad.json.problems.join(" ")).toMatch(/forge\.\* namespace/);
    const reserved = await api(cookie, "/api/forge/submit", { method: "POST", body: { ...ownerSpec(), name: "forge.submit" } });
    expect(reserved.status).toBe(422);
    expect((await api(cookie, "/api/forge/tools")).json.tools).toHaveLength(0);
    await submitAndDrain(cookie);
    const dup = await api(cookie, "/api/forge/submit", { method: "POST", body: ownerSpec() });
    expect(dup.status).toBe(200);
    expect(dup.json).toMatchObject({ duplicate: true, tool: { status: "admitted" } });
    expect((await api(cookie, "/api/forge/tools/forge.nope")).status).toBe(404);
    // missing CSRF header is refused like every other write
    const noCsrf = await (await import("cloudflare:test")).SELF.fetch("https://k.test/api/forge/submit", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(noCsrf.status).toBe(403);
  });

  it("deterministic critic rejects sandbox-escape patterns (mock mode)", { timeout: T }, async () => {
    const v = await mockForgeCritic("lin_critic").review({ spec: slugifySpec(), warnings: ["uses eval()"], gates: [] });
    expect(v).toMatchObject({ approve: false, risk: "high" });
    const cookie = await login();
    const code = `function run(x) { var f = eval("1"); return { slug: String(x.text).toLowerCase() }; }`;
    const { job } = await submitAndDrain(cookie, { ...ownerSpec(), name: "forge.text.lower", code, tests: [{ input: { text: "AB" }, expect: { slug: "ab" } }] });
    expect(job.result).toMatchObject({ status: "rejected" });
    const t = (await getToolByName(E, "forge.text.lower"))!;
    expect(t.status).toBe("rejected");
    expect(t.report!.gates.find((g) => g.gate === "critic")).toMatchObject({ pass: false });
  });

  it("a cancelled admission leaves the row pending with a note", { timeout: T }, async () => {
    const cookie = await login();
    const r = await api(cookie, "/api/forge/submit", { method: "POST", body: ownerSpec() });
    await api(cookie, `/api/jobs/${r.json.job_id}/cancel`, { method: "POST", body: {} });
    const j = (await getJob(E, r.json.job_id))!;
    expect(j.status).toBe("cancelled");
    const t = (await getToolByName(E, "forge.text.slugify"))!;
    expect(t.status).toBe("pending");
    expect(t.status_reason).toMatch(/resubmit/);
  });
});

describe("forged tools in the Tool Gateway", () => {
  it("granted via forge.* → runs in the sandbox with governor budget + audit; not granted → denied", { timeout: T }, async () => {
    await seedStarterOrg(E);
    const cookie = await login();
    await submitAndDrain(cookie);
    const gw = (ids: string[], sandboxed = false) => new ToolGateway({ env: E, agentId: "a_builder", role: "builder", runId: "run_f", sandboxed, genomeToolIds: ids, memory: mem() });
    const ok = await gw(["think", "forge.*"]).call("forge.text.slugify", { text: "Bee Hive" });
    expect(ok).toMatchObject({ status: "ok", tier: 1, result: { slug: "bee-hive" } });
    const exact = await gw(["forge.text.slugify"]).call("forge.text.slugify", { text: "x y" });
    expect(exact.status).toBe("ok");
    const denied = await gw(["think"]).call("forge.text.slugify", { text: "a" });
    expect(denied).toMatchObject({ status: "denied", reason: "not_in_genome" });
    const unknown = await gw(["forge.*"]).call("forge.nope.tool", {});
    expect(unknown).toMatchObject({ status: "denied", reason: "unknown_tool" });
    const missing = await gw(["forge.*"]).call("forge.text.slugify", { wrong: 1 });
    expect(missing).toMatchObject({ status: "denied", reason: "missing_arg:text" });
    const err = await gw(["forge.*"]).call("forge.text.slugify", { text: 5 });
    expect(err.status).toBe("error");
    const usage = await new Governor(E).usage();
    expect(usage.find((u) => u.scope === "forge" && u.metric === "sandbox_runs")?.used).toBe(3);
    const t = (await getToolByName(E, "forge.text.slugify"))!;
    // schema-invalid args never reach the sandbox (no forge_runs row), but they do cost a gateway debit
    expect(t.uses).toBe(2);
    expect(t.successes).toBe(2);
    expect((await runsFor(E, t.id)).filter((r: any) => r.context === "call" && r.caller === "agent:a_builder")).toHaveLength(2);
    const log = await listAudit(E.DB, 20);
    expect(log.some((a) => a.action === "tool.call" && a.target === "forge.text.slugify")).toBe(true);
  });

  it("forge.submit by an agent → owner approval queue (compact args) → approve starts admission → admitted", { timeout: T }, async () => {
    await seedStarterOrg(E);
    const cookie = await login();
    const gw = new ToolGateway({ env: E, agentId: "a_builder", role: "builder", runId: "run_s", sandboxed: false, genomeToolIds: ["forge.submit"], memory: mem() });
    const spec = slugifySpec();
    const r = await gw.call("forge.submit", { name: spec.name, description: spec.description, input_schema: spec.input_schema, output_schema: spec.output_schema, code: spec.code, tests: spec.tests });
    expect(r.status).toBe("pending_approval");
    const apr = (await api(cookie, "/api/approvals?status=pending")).json.approvals[0];
    expect(apr.tool_id).toBe("forge.submit");
    const args = JSON.parse(apr.args);
    expect(args).toMatchObject({ name: "forge.text.slugify", version: 1, tests: 3 });
    expect(args.code).toBeUndefined(); // the code stays in forge_tools, not in the approval row
    const staged = (await getToolByName(E, "forge.text.slugify"))!;
    expect(staged.status).toBe("pending");
    expect(staged.author).toBe("agent:a_builder");
    expect(staged.status_reason).toMatch(/awaiting owner approval/);

    const dec = await api(cookie, `/api/approvals/${apr.id}/approve`, { method: "POST", body: {} });
    expect(dec.json.approval.status).toBe("executed");
    const out = JSON.parse(dec.json.approval.result);
    expect(out).toMatchObject({ status: "admission_started", job_id: expect.any(String) });
    const job = await drainJob(E, out.job_id);
    expect(job.result).toMatchObject({ status: "admitted" });
    expect((await getToolByName(E, "forge.text.slugify"))!.status).toBe("admitted");
  });

  it("forge.submit: invalid spec denied up front; owner reject marks the staged row rejected; sandboxed agents are simulated", { timeout: T }, async () => {
    await seedStarterOrg(E);
    const cookie = await login();
    const mk = (sandboxed: boolean) => new ToolGateway({ env: E, agentId: "a_builder", role: "builder", runId: "run_x", sandboxed, genomeToolIds: ["forge.submit"], memory: mem() });
    const spec = slugifySpec();
    const bad = await mk(false).call("forge.submit", { name: "forge.x", description: "short", input_schema: { type: "object" }, code: "x", tests: [] });
    expect(bad.status).toBe("denied");
    expect((bad as any).reason).toMatch(/^invalid_args/);
    const sim = await mk(true).call("forge.submit", { name: spec.name, description: spec.description, input_schema: spec.input_schema, code: spec.code, tests: spec.tests });
    expect(sim.status).toBe("sandboxed");
    expect(await getToolByName(E, spec.name)).toBeNull();
    const r = await mk(false).call("forge.submit", { spec: JSON.stringify({ ...spec, author: "x", lineage: "y" }) });
    expect(r.status).toBe("pending_approval");
    const id = (r as any).approval_id;
    await api(cookie, `/api/approvals/${id}/reject`, { method: "POST", body: { note: "no" } });
    const t = (await getToolByName(E, spec.name))!;
    expect(t.status).toBe("rejected");
    expect(t.status_reason).toBe("owner rejected the submission");
  });
});
