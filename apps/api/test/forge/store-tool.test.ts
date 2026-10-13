import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { submitTool } from "../../src/forge/admission";
import { getAdmittedTool, listTools, runsFor, specOf } from "../../src/forge/store";
import { executeForgeTool, FORGE_TIER, forgeToolDefs, listForgeCatalog } from "../../src/forge/tool";
import { freshState } from "../helpers";
import { approveCritic, slugifySpec } from "./fixtures";

beforeEach(freshState);
const E = env as Env;
const deps = { critic: approveCritic(), fuzzCases: 4 };

describe("forge store", () => {
  it("submitTool persists pending → admitted with a content-hashed, versioned row", async () => {
    const { tool, report, duplicate } = await submitTool(E, slugifySpec(), deps);
    expect(duplicate).toBe(false);
    expect(report.status).toBe("admitted");
    expect(tool).toMatchObject({ name: "forge.text.slugify", version: 1, status: "admitted", author: "agent:toolsmith-1", lineage_id: "lin_toolsmith" });
    expect(tool.id).toBe(`ft_${report.hash.slice(0, 24)}`);
    expect(tool.report?.gates).toHaveLength(7);
    expect(tool.admitted_at).toBeTruthy();
    expect(specOf(tool).code).toContain("function run");
    expect((await runsFor(E, tool.id)).map((r: any) => r.context)).toEqual(["admission"]);
  });

  it("the same spec again is a duplicate (no re-run, no new version)", async () => {
    await submitTool(E, slugifySpec(), deps);
    const again = await submitTool(E, slugifySpec({ author: "agent:other" }), deps);
    expect(again.duplicate).toBe(true);
    expect((await listTools(E, { name: "forge.text.slugify" })).length).toBe(1);
  });

  it("a new admitted version deprecates the previous one", async () => {
    const v1 = await submitTool(E, slugifySpec(), deps);
    const v2 = await submitTool(E, slugifySpec({ description: "Turn a title into a URL slug — v2 with clearer description text." }), deps);
    expect(v2.tool.version).toBe(2);
    const rows = await listTools(E, { name: "forge.text.slugify" });
    expect(rows.find((r) => r.id === v1.tool.id)?.status).toBe("deprecated");
    expect(rows.find((r) => r.id === v1.tool.id)?.status_reason).toMatch(/superseded by v2/);
    expect((await getAdmittedTool(E, "forge.text.slugify"))?.version).toBe(2);
  });

  it("rejected submissions are stored with their report and are never executable", async () => {
    const bad = await submitTool(E, slugifySpec({ tests: [{ input: { text: "A B" }, expect: { slug: "nope" } }] }), deps);
    expect(bad.tool.status).toBe("rejected");
    expect(bad.tool.status_reason).toMatch(/author_tests/);
    expect(await getAdmittedTool(E, "forge.text.slugify")).toBeNull();
    expect((await executeForgeTool(E, "forge.text.slugify", { text: "x" })).errorKind).toBe("unknown_tool");
  });
});

describe("forge gateway adapter", () => {
  it("lists admitted tools as tier-1 catalog entries", async () => {
    await submitTool(E, slugifySpec(), deps);
    await submitTool(E, slugifySpec({ name: "forge.text.bad", tests: [{ input: { text: "a" }, expect: 0 }] }), deps);
    const cat = await listForgeCatalog(E);
    expect(cat).toHaveLength(1);
    expect(cat[0]).toMatchObject({ id: "forge.text.slugify", tier: FORGE_TIER, schema: { required: ["text"], properties: { text: { type: "string" }, max: { type: "integer" } } } });
    expect(FORGE_TIER).toBe(1);
    expect(cat[0].forge).toMatchObject({ version: 1, uses: 0, success_rate: null });
  });

  it("executes an admitted tool in the sandbox and records usage", async () => {
    await submitTool(E, slugifySpec(), deps);
    const ok = await executeForgeTool(E, "forge.text.slugify", { text: "Tool Forge, P4!" }, { caller: "agent:a1", run_id: "run_1" });
    expect(ok).toMatchObject({ ok: true, value: { slug: "tool-forge-p4" }, version: 1 });
    const badArgs = await executeForgeTool(E, "forge.text.slugify", { text: 5 });
    expect(badArgs).toMatchObject({ ok: false, errorKind: "invalid_args" });
    const t = (await getAdmittedTool(E, "forge.text.slugify"))!;
    expect(t).toMatchObject({ uses: 1, successes: 1, failures: 0 });
    const runs = await runsFor(E, t.id);
    expect(runs.find((r: any) => r.context === "call")).toMatchObject({ caller: "agent:a1", run_id: "run_1", ok: 1 });
    expect((await listForgeCatalog(E))[0].forge.success_rate).toBe(1);
  });

  it("forgeToolDefs handlers run through the sandbox and throw on tool errors", async () => {
    await submitTool(E, slugifySpec(), deps);
    const [def] = await forgeToolDefs(E);
    const ctx = { env: E, agentId: "a1", role: "builder", sandboxed: false } as any;
    expect(await def.handler(ctx, { text: "Hello There" })).toEqual({ slug: "hello-there" });
    await expect(def.handler(ctx, {})).rejects.toThrow(/invalid args/);
    const t = (await getAdmittedTool(E, "forge.text.slugify"))!;
    expect(t).toMatchObject({ uses: 1, successes: 1 });
  });
});
