import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { FAMILY_MAP } from "../../src/eval/families";
import { evalMaintenance } from "../../src/eval/maintenance";
import { getItem, listItems, recordResult } from "../../src/eval/store";
import { Governor } from "../../src/governor/governor";
import { Registry } from "../../src/registry/registry";
import { seedStarterOrg } from "../../src/registry/seed";
import { ToolGateway } from "../../src/tools/gateway";
import { home } from "../../src/home/stub";
import { authorTaskText } from "../../src/eval/prompts";
import { listAudit } from "../../src/audit";
import { api, freshState, login } from "../helpers";

const E = env as Env;
beforeEach(freshState);

async function seedCode(cookie: string) {
  const r = await api(cookie, "/api/evals/seed", { method: "POST", body: { sync: true, suites: ["code-core"] } });
  expect(r.status).toBe(200);
  return r.json;
}

const gwFor = async (agentId: string) => {
  const reg = new Registry(E);
  const a = (await reg.getAgent(agentId))!;
  const g = (await reg.getGenome(a.genome_id))!;
  return new ToolGateway({ env: E, agentId, role: g.role, lineage: g.lineage_id, runId: "run_t", sandboxed: false, genomeToolIds: g.tool_ids });
};

function authoredArgs(seed: string, d = 7) {
  const g = FAMILY_MAP.arith.generate(seed, d);
  return { suite_id: "code-core", task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: d, tags: [...g.tags, "authored"], split: "private" };
}

describe("eval API: auth", () => {
  it("every /api/evals route needs the owner session; mutations need x-khaliya", async () => {
    for (const [m, p] of [
      ["GET", "/api/evals/suites"],
      ["GET", "/api/evals/suites/code-core/items"],
      ["GET", "/api/evals/items/ei_x"],
      ["POST", "/api/evals/seed"],
      ["POST", "/api/evals/suites/code-core/saturation"],
      ["POST", "/api/evals/suites/code-core/run"],
      ["POST", "/api/evals/items/ei_x/retire"],
      ["POST", "/api/evals/retire-flaky"],
    ]) {
      const r = await SELF.fetch(`https://k.test${p}`, { method: m, headers: { "x-khaliya": "1", "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    const cookie = await login();
    const noHeader = await SELF.fetch("https://k.test/api/evals/seed", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(403);
  });
});

describe("eval API: owner views", () => {
  it("seed then list suites with counts; owner sees references; item detail has validation + results", async () => {
    const cookie = await login();
    const s = await seedCode(cookie);
    expect(s.complete).toBe(true);
    expect(s.suites[0].suite_id).toBe("code-core");

    const suites = await api(cookie, "/api/evals/suites");
    expect(suites.status).toBe(200);
    const code = suites.json.suites.find((x: any) => x.id === "code-core");
    expect(code).toMatchObject({ role: "builder", level: 5 });
    expect(code.counts.by_split_status).toMatchObject({ "public:active": 6, "private:active": 8, "canary:active": 2 });
    expect(code.counts.total).toBeGreaterThanOrEqual(16);
    expect(code).toHaveProperty("saturation");

    const items = await api(cookie, "/api/evals/suites/code-core/items?split=private&status=active");
    expect(items.json.items).toHaveLength(8);
    const it0 = items.json.items[0];
    expect(typeof it0.reference).toBe("string");
    expect(it0.reference.length).toBeGreaterThan(0);
    expect(it0.checker).toBeTruthy();

    const det = await api(cookie, `/api/evals/items/${it0.id}`);
    expect(det.status).toBe(200);
    expect(det.json.item.reference).toBe(it0.reference);
    expect(det.json.item.checker).toEqual(it0.checker);
    expect(det.json.validation.outcome).toBe("active");
    expect(det.json.validation.stages.structure.ok).toBe(true);
    expect(Array.isArray(det.json.results)).toBe(true);
    expect(det.json.results.length).toBeGreaterThan(0); // validation baselines recorded

    expect((await api(cookie, "/api/evals/items/ei_nope")).status).toBe(404);
    expect((await api(cookie, "/api/evals/suites/nope/items")).status).toBe(404);
    expect((await api(cookie, "/api/evals/seed", { method: "POST", body: { suites: ["nope"] } })).status).toBe(400);
  }, 60_000);

  it("run endpoint scores a genome on private items; saturation; retire; retire-flaky", async () => {
    const cookie = await login();
    await seedStarterOrg(E);
    await seedCode(cookie);

    const run = await api(cookie, "/api/evals/suites/code-core/run", { method: "POST", body: { agent_id: "a_builder" } });
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ suite_id: "code-core", genome_source: "agent", role: "builder", role_matches_suite: true, n: 8 });
    expect(run.json.pass_rate).toBeGreaterThanOrEqual(0);
    expect(run.json.pass_rate).toBeLessThanOrEqual(1);
    expect(run.json.results).toHaveLength(8);
    const champ = await api(cookie, "/api/evals/suites/code-core/run", { method: "POST", body: {} });
    expect(champ.json.genome_source).toBe("champion");
    expect((await api(cookie, "/api/evals/suites/code-core/run", { method: "POST", body: { agent_id: "a_ghost" } })).status).toBe(404);
    expect((await api(cookie, "/api/evals/suites/nope/run", { method: "POST", body: {} })).status).toBe(404);

    const sat = await api(cookie, "/api/evals/suites/code-core/saturation", { method: "POST", body: { sync: true, ladder: false } });
    expect(sat.status).toBe(200);
    expect(sat.json).toMatchObject({ suite_id: "code-core", n: 8 });
    expect(sat.json.ladder).toBeNull();

    const items = await listItems(E, { suite_id: "code-core", status: "active", split: "private" });
    const ret = await api(cookie, `/api/evals/items/${items[0].id}/retire`, { method: "POST", body: { reason: "stale" } });
    expect(ret.json.item).toMatchObject({ status: "retired", status_reason: "owner: stale" });

    // a flaky item (same genome flips twice) is retired by the endpoint
    const flaky = items[1];
    for (const pass of [true, false, true]) await recordResult(E, { item_id: flaky.id, genome_id: "g_x", context: "recheck", pass, score: pass ? 1 : 0 });
    const rf = await api(cookie, "/api/evals/retire-flaky", { method: "POST", body: { suite_id: "code-core" } });
    expect(rf.json.retired).toEqual([flaky.id]);
    expect((await getItem(E, flaky.id))!.status).toBe("retired");
  }, 90_000);

  it("lab budget errors map to 429 and the kill switch to 423", async () => {
    const cookie = await login();
    await new Governor(E).setKill("global", true);
    const r = await api(cookie, "/api/evals/seed", { method: "POST", body: { suites: ["code-core"] } });
    expect(r.status).toBe(423);
    expect(r.json.code).toBe("lab_killed");
    await new Governor(E).setKill("global", false);
    const t = await api(cookie, "/api/evals/seed", { method: "POST", body: { sync: true, suites: ["code-core"], max_calls: 1 } });
    expect(t.status).toBe(429);
    expect(t.json.code).toBe("lab_tick");
  });
});

describe("eval tools through the gateway", () => {
  it("evaluator can author (validated, attributed to its lineage); builder is denied; no references leak", async () => {
    const cookie = await login();
    await seedStarterOrg(E);
    await seedCode(cookie);

    const ev = await gwFor("a_evaluator");
    const r = await ev.call("eval.author", authoredArgs("api-test:1"));
    expect(r.status).toBe("ok");
    const res = (r as any).result;
    expect(["active", "reserve", "rejected"]).toContain(res.status);
    expect(Array.isArray(res.reasons)).toBe(true);
    expect(res.gates.map((g: any) => g.gate)).toContain("structure");
    if (res.stored) {
      const item = (await getItem(E, res.item_id))!;
      expect(item.author).toBe("agent:a_evaluator");
      expect(item.author_lineage).toBe("evaluator");
    }
    // the result never carries any item's reference or checker
    const others = await listItems(E, { suite_id: "code-core" });
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('"reference"');
    for (const o of others.filter((o) => o.reference.length >= 6)) expect(blob).not.toContain(o.reference);

    // canary split is not authorable; resubmitting the same item is a duplicate
    const canary = await ev.call("eval.author", { ...authoredArgs("api-test:2"), split: "canary" });
    expect(canary).toMatchObject({ status: "error" });
    if (res.stored) {
      const dup = await ev.call("eval.author", authoredArgs("api-test:1"));
      expect((dup as any).result).toMatchObject({ status: "rejected", duplicate: true, stored: false });
      expect((dup as any).result.reason).not.toMatch(/ei_[a-f0-9]{6,}/);
    }

    const pub = await ev.call("eval.list_public", { suite_id: "code-core" });
    expect(pub.status).toBe("ok");
    const list = (pub as any).result as any[];
    expect(list).toHaveLength(6);
    for (const p of list) {
      expect(p).not.toHaveProperty("reference");
      expect(p).not.toHaveProperty("checker");
      expect(typeof p.format).toBe("string");
    }

    const critic = await gwFor("a_critic");
    expect((await critic.call("eval.list_public", {})).status).toBe("ok");
    expect(await critic.call("eval.author", authoredArgs("api-test:3"))).toMatchObject({ status: "denied", reason: "not_in_genome" });

    const builder = await gwFor("a_builder");
    expect(await builder.call("eval.author", authoredArgs("api-test:4"))).toMatchObject({ status: "denied", reason: "not_in_genome" });
    // even a forged grant on a builder only gets past the genome check with the same tool in the list
    const forged = new ToolGateway({ env: E, agentId: "a_builder", role: "builder", runId: "r", sandboxed: false, genomeToolIds: ["think"] });
    expect(await forged.call("eval.author", authoredArgs("api-test:5"))).toMatchObject({ status: "denied", reason: "not_in_genome" });
  }, 90_000);

  it("a sandboxed evaluator's item is validated but not stored", async () => {
    const cookie = await login();
    await seedStarterOrg(E);
    await seedCode(cookie);
    const reg = new Registry(E);
    const g = (await reg.getGenome((await reg.getAgent("a_evaluator"))!.genome_id))!;
    const gw = new ToolGateway({ env: E, agentId: "a_evaluator", role: "evaluator", runId: "r", sandboxed: true, genomeToolIds: g.tool_ids });
    const before = (await listItems(E, { limit: 5000 })).length;
    const r = await gw.call("eval.author", authoredArgs("api-test:sb"));
    expect(r.status).toBe("ok");
    expect((r as any).result).toMatchObject({ stored: false, sandboxed: true, item_id: null });
    expect((await listItems(E, { limit: 5000 })).length).toBe(before);
  }, 60_000);
});

describe("evaluator agent run (ladder hand-off)", () => {
  it("an AUTHOR_EVAL_ITEMS task makes the evaluator call eval.author through the real runtime", async () => {
    const cookie = await login();
    await seedStarterOrg(E);
    await seedCode(cookie);
    const task = authorTaskText("code-core", "builder", 7, ["arith"], []);
    const r: any = await home(E, "a_evaluator").runTask("a_evaluator", task);
    expect(r.status).toBe("done");
    const calls = (await listAudit(E.DB, 200)).filter((e: any) => e.action === "tool.call" && e.target === "eval.author");
    expect(calls.length).toBe(1);
    const authored = await listItems(E, { suite_id: "code-core", author: "agent:a_evaluator" });
    for (const it of authored) expect(it.author_lineage).toBe("evaluator");
  }, 60_000);
});

describe("daily eval maintenance", () => {
  it("retires flaky items, skips under the global kill switch, never throws", async () => {
    const cookie = await login();
    await seedCode(cookie);
    const [a] = await listItems(E, { suite_id: "code-core", status: "active", limit: 1 });
    for (const pass of [true, false, true]) await recordResult(E, { item_id: a.id, genome_id: "g_y", context: "recheck", pass, score: pass ? 1 : 0 });
    await new Governor(E).setKill("global", true);
    expect(await evalMaintenance(E)).toEqual({ skipped: "kill_global" });
    expect((await getItem(E, a.id))!.status).toBe("active");
    await new Governor(E).setKill("global", false);
    const r = await evalMaintenance(E);
    expect(r.retired).toBe(1);
    expect((await getItem(E, a.id))!.status).toBe("retired");
  }, 60_000);
});
