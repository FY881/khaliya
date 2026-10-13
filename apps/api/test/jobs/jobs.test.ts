import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { listAudit } from "../../src/audit";
import { strongBaseline, weakBaseline } from "../../src/eval/baselines";
import { FAMILY_MAP, STARTER_SUITES, familiesForSuite } from "../../src/eval/families";
import { LabLLM } from "../../src/eval/llm";
import { MAX_BUMP, newSeedCursor, seedSuite } from "../../src/eval/seed";
import { parseAnswer } from "../../src/eval/solver";
import { reviewItemMessages } from "../../src/eval/prompts";
import { ensureSuite, insertItem, listItems } from "../../src/eval/store";
import type { Split } from "../../src/eval/types";
import { lockState } from "../../src/evolution/store";
import { Governor } from "../../src/governor/governor";
import { createJob, getJob } from "../../src/jobs/store";
import { drainJob } from "../../src/jobs/runner";
import { DEFAULT_CHAIN, DEPRECATED_MODELS, ModelRouter, WORKERS_AI_SMALL } from "../../src/llm/router";
import { seedStarterOrg } from "../../src/registry/seed";
import { api, freshState, login } from "../helpers";

const E = env as Env;
const T = 110_000;
beforeEach(freshState);

describe("answer parsing (real-model replies)", () => {
  it("recovers the answer from prose, fences, plans and brace-less pairs; never invents one", () => {
    expect(parseAnswer('{"answer": 42}')).toBe("42");
    expect(parseAnswer('{"work": "6*7", "answer": [1,2]}')).toBe("[1,2]");
    expect(parseAnswer('Plan:\n1. sort\n2. return\n```json\n{"answer": [-3, 1, 9]}\n```')).toBe("[-3,1,9]");
    expect(parseAnswer('I think {"draft": 1} then {"answer": "Paris"} is final.')).toBe("Paris");
    expect(parseAnswer('{"answer": "a {brace} inside", "work": "x"}')).toBe("a {brace} inside");
    expect(parseAnswer('"answer": 42')).toBe("42");
    expect(parseAnswer('the answer is "answer": "B7"')).toBe("B7");
    expect(parseAnswer("To solve this task, I will follow the plan-execute strategy.")).toBe("To solve this task, I will follow the plan-execute strategy.");
    expect(parseAnswer('{"answer": null}')).toBe("");
  });
});

describe("critic review prompt", () => {
  it("gives the critic the Governor-side facts: canary rule, machine-verified reference; blocking vs suggestions", async () => {
    const critic = await strongBaseline("critic");
    const canary = FAMILY_MAP.safety.generate("x", 1, 0);
    const c1 = reviewItemMessages(critic, { ...canary, difficulty: 1 }, { safety_canary: true }).map((m) => m.content).join("\n");
    expect(c1).toMatch(/SAFETY CANARY/);
    expect(c1).toMatch(/blocking_issues/);
    const g = FAMILY_MAP.gcd.generate("y", 3);
    const c2 = reviewItemMessages(critic, { ...g, difficulty: 3 }, { reference_verified: true }).map((m) => m.content).join("\n");
    expect(c2).toMatch(/independent program/);
    expect(c2).not.toMatch(/SAFETY CANARY/);
    expect(reviewItemMessages(critic, { ...g, difficulty: 3 }).map((m) => m.content).join("\n")).not.toMatch(/CONTEXT:/);
  });
});

describe("model lists", () => {
  it("no deprecated model in the default chain; legacy genomes skip it; weak baseline is pinned to small models", async () => {
    for (const m of DEPRECATED_MODELS) expect(DEFAULT_CHAIN).not.toContain(m);
    for (const m of WORKERS_AI_SMALL) expect(DEFAULT_CHAIN).not.toContain(m);
    const real = { ...E, LLM_MODE: "auto", GEMINI_KEY: "k", OPENROUTER_KEY: "o" } as Env;
    const r = new ModelRouter(real);
    const legacy = r.chain({ primary: "workers-ai:@cf/meta/llama-3.1-8b-instruct", fallbacks: [], temperature: 0.3 });
    expect(legacy).not.toContain("workers-ai:@cf/meta/llama-3.1-8b-instruct");
    expect(r.chain({ primary: "workers-ai:@cf/meta/llama-3.1-8b-instruct", fallbacks: [], temperature: 0 }, true)).toEqual([]);
    const weak = await weakBaseline("builder");
    const pinned = r.chain(weak.model_policy, false, true);
    expect(pinned).toEqual(WORKERS_AI_SMALL);
    // unpinned it would have fallen through to strong models — the bug that broke the discriminative gate
    expect(r.chain(weak.model_policy).some((m) => m.startsWith("gemini:"))).toBe(true);
    const strong = await strongBaseline("builder");
    expect(r.chain(strong.model_policy).some((m) => WORKERS_AI_SMALL.includes(m))).toBe(false);
  });

  it("a model that answers 'deprecated' (5028) is parked for the isolate and the next model answers", async () => {
    let calls = 0;
    const real = { ...E, LLM_MODE: "auto", GEMINI_KEY: undefined, OPENROUTER_KEY: undefined } as Env;
    const r = new ModelRouter(real, {
      providers: {
        "workers-ai": {
          name: "workers-ai",
          needsKey: false,
          async call({ model }) {
            calls++;
            if (model === "@cf/old/model") throw Object.assign(new Error("workers-ai: 5028: model deprecated"), { status: 502 });
            return { text: "ok", model: `workers-ai:${model}`, provider: "workers-ai", tokensIn: 1, tokensOut: 1 };
          },
        },
      },
    });
    const policy = { primary: "workers-ai:@cf/old/model", fallbacks: [], temperature: 0.3 };
    expect((await r.complete({ messages: [{ role: "user", content: "x" }] }, policy)).text).toBe("ok");
    const before = calls;
    expect(r.chain(policy)).not.toContain("workers-ai:@cf/old/model");
    await r.complete({ messages: [{ role: "user", content: "y" }] }, policy);
    expect(calls - before).toBe(1);
  });
});

describe("seed calibration: difficulty escalation", () => {
  it(
    "a weak baseline that passes rejects the item (gate unchanged) and escalates the next candidates; replay is free and deterministic",
    async () => {
      const def = STARTER_SUITES.find((s) => s.id === "code-core")!;
      const strong = await strongBaseline("builder");
      // "weak" = the strong genome → every solvable item is non-discriminative and must be rejected
      const lab1 = new LabLLM(E, { maxCalls: 5000, share: 1 });
      const s1 = await seedSuite(E, lab1, def, { weak: strong });
      expect(s1.splits.public.rejected).toBeGreaterThan(0);
      expect(s1.splits.public.bump).toBeGreaterThan(0);
      expect(s1.splits.public.bump).toBeLessThanOrEqual(MAX_BUMP);
      const weakRej = s1.rejections.filter((r) => r.includes("discriminative: weak baseline passes"));
      expect(weakRej.length).toBeGreaterThan(0);
      const items = await listItems(E, { suite_id: "code-core", split: "public", limit: 500 });
      expect(items.some((i) => i.tags.some((t) => t.startsWith("escalated+")))).toBe(true);
      expect(items.filter((i) => i.status === "active").length).toBe(0); // anti-cheat intact: nothing slipped through
      // replay: same trajectory, zero LLM calls
      const lab2 = new LabLLM(E, { maxCalls: 5000, share: 1 });
      const s2 = await seedSuite(E, lab2, def, { weak: strong });
      expect(lab2.calls).toBe(0);
      expect(s2.splits.public.bump).toBe(s1.splits.public.bump);
      expect(s2.splits.public.created).toBe(0);
    },
    T,
  );

  it("a step interrupted mid-item restores the cursor (the candidate is not skipped)", async () => {
    const job = await createJob(E, { kind: "eval.seed", params: {}, state: { cursor: newSeedCursor([STARTER_SUITES.find((s) => s.id === "code-core")!]) }, total: 16, max_calls: 1 });
    const j = await drainJob(E, job.id);
    expect(j).toMatchObject({ status: "done", stopped: "budget" });
    expect((j.state as any).cursor.n).toBe(0); // the half-validated candidate #0 will be retried
    expect((await listItems(E, { suite_id: "code-core" })).length).toBe(0);
  });
});

async function plantItems(nPrivate = 8) {
  const def = STARTER_SUITES.find((s) => s.id === "code-core")!;
  await ensureSuite(E, def);
  const fams = familiesForSuite("code-core");
  let n = 0;
  const add = async (split: Split, d: number, kind: string) => {
    const g = FAMILY_MAP[kind]!.generate(`jobs-test:${split}:${n}`, d, n);
    n++;
    await insertItem(
      E,
      { suite_id: "code-core", task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: d, tags: g.tags, split },
      { role: "builder", author: "system:seed", status: "active" },
    );
  };
  for (let i = 0; i < 3; i++) await add("public", 1, fams[i % fams.length]!.kind);
  for (let i = 0; i < 2; i++) await add("canary", 1, "safety");
  for (let i = 0; i < nPrivate; i++) await add("private", 4, fams[i % fams.length]!.kind);
}

describe("job API", () => {
  it(
    "seed returns 202 + job_id at once; chunks run to completion; progress, result, list, dedupe, no cursor leak",
    async () => {
      const cookie = await login();
      const r = await api(cookie, "/api/evals/seed", { method: "POST", body: { suites: ["code-core"] } });
      expect(r.status).toBe(202);
      expect(r.json.job_id).toMatch(/^job_/);
      expect(r.json.poll).toBe(`/api/jobs/${r.json.job_id}`);
      expect(["queued", "running"]).toContain(r.json.job.status);
      expect(r.json.job.state).toBeUndefined();
      const again = await api(cookie, "/api/evals/seed", { method: "POST", body: { suites: ["code-core"] } });
      if (["queued", "running"].includes((await getJob(E, r.json.job_id))!.status)) {
        expect(again.json.job_id).toBe(r.json.job_id);
        expect(again.json.reused).toBe(true);
      }

      const done = await drainJob(E, r.json.job_id);
      expect(done.status, done.error ?? "").toBe("done");
      expect(done.chunks).toBeGreaterThan(1); // really chunked
      expect(done.progress.pct).toBe(100);
      expect((done.result as any).complete).toBe(true);
      expect((done.result as any).active).toBe(16);
      expect(done.llm_calls).toBeGreaterThan(0);
      expect(done.llm_calls).toBeLessThanOrEqual(done.max_calls);

      const g = await api(cookie, `/api/jobs/${r.json.job_id}`);
      expect(g.status).toBe(200);
      expect(g.json.job).toMatchObject({ id: r.json.job_id, kind: "eval.seed", status: "done" });
      expect(g.json.job.state).toBeUndefined();
      const list = await api(cookie, "/api/jobs?kind=eval.seed");
      expect(list.json.jobs.map((j: any) => j.id)).toContain(r.json.job_id);
      expect((await api(cookie, "/api/jobs/job_nope")).status).toBe(404);
      expect((await listAudit(E.DB, 100)).some((a) => a.action === "eval.seed")).toBe(true);
    },
    T,
  );

  it(
    "a job stops on its call budget and a second job resumes idempotently; kill switch → 423 / stopped",
    async () => {
      const cookie = await login();
      const r = await api(cookie, "/api/evals/seed", { method: "POST", body: { suites: ["code-core"], max_calls: 20 } });
      const j1 = await drainJob(E, r.json.job_id);
      expect(j1.status).toBe("done");
      expect(j1.stopped).toBe("budget");
      expect(j1.llm_calls).toBeLessThanOrEqual(20);
      const created1 = (await listItems(E, { suite_id: "code-core", limit: 500 })).length;
      expect(created1).toBeGreaterThan(0);

      const r2 = await api(cookie, "/api/evals/seed", { method: "POST", body: { suites: ["code-core"] } });
      const j2 = await drainJob(E, r2.json.job_id);
      expect(j2.status).toBe("done");
      expect((j2.result as any).complete).toBe(true);
      const ids = (await listItems(E, { suite_id: "code-core", limit: 500 })).map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);

      await new Governor(E).setKill("global", true);
      const k = await api(cookie, "/api/evals/seed", { method: "POST", body: { suites: ["research-core"] } });
      expect(k.status).toBe(423);
      const job = await createJob(E, { kind: "eval.seed", params: {}, state: { cursor: newSeedCursor([STARTER_SUITES[0]]) }, total: 16, max_calls: 100 });
      const jk = await drainJob(E, job.id);
      expect(jk).toMatchObject({ status: "done", stopped: "killed" });
      await new Governor(E).setKill("global", false);
    },
    T,
  );

  it("a provider whose daily cap is used up stops the job as daily_budget (no retry storm)", async () => {
    await E.DB.prepare("INSERT INTO budgets (day, scope, metric, used, cap) VALUES (?1, 'provider:mock', 'llm_calls', 100000000, 0) ON CONFLICT DO UPDATE SET used = 100000000")
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    const job = await createJob(E, { kind: "eval.seed", params: {}, state: { cursor: newSeedCursor([STARTER_SUITES.find((s) => s.id === "code-core")!]) }, total: 16, max_calls: 100 });
    const j = await drainJob(E, job.id);
    expect(j).toMatchObject({ status: "done", stopped: "daily_budget", failures: 0 });
    expect(j.message).toMatch(/daily/);
  });

  it("failing chunks retry then fail the job; unknown kinds fail; cancel works", async () => {
    const cookie = await login();
    const bad = await createJob(E, { kind: "eval.seed", params: {}, state: { cursor: { ...newSeedCursor([]), suites: ["nope"], done: false } }, total: 1, max_calls: 10 });
    const jb = await drainJob(E, bad.id);
    expect(jb.status).toBe("failed");
    expect(jb.failures).toBe(3);
    expect(jb.error).toMatch(/unknown suite/);
    const unk = await createJob(E, { kind: "nope", params: {}, state: {}, total: 1, max_calls: 10 });
    expect((await drainJob(E, unk.id)).status).toBe("failed");

    const q = await createJob(E, { kind: "eval.seed", params: {}, state: { cursor: newSeedCursor([STARTER_SUITES[0]]) }, total: 16, max_calls: 100 });
    const c = await api(cookie, `/api/jobs/${q.id}/cancel`, { method: "POST", body: {} });
    expect(c.status).toBe(200);
    expect(c.json.job).toMatchObject({ status: "cancelled", stopped: "cancelled" });
    expect((await api(cookie, `/api/jobs/${q.id}/cancel`, { method: "POST", body: {} })).status).toBe(409);
  });

  it(
    "saturation, generation and tick run as jobs; generation holds and releases the evolution lock",
    async () => {
      await seedStarterOrg(E);
      await plantItems();
      const cookie = await login();

      const sat = await api(cookie, "/api/evals/suites/code-core/saturation", { method: "POST", body: { ladder: false } });
      expect(sat.status).toBe(202);
      const js = await drainJob(E, sat.json.job_id);
      expect(js.status, js.error ?? "").toBe("done");
      expect(js.result).toMatchObject({ suite_id: "code-core", n: 8, ladder: null });
      expect(js.progress.pct).toBe(100);

      const gen = await api(cookie, "/api/evolution/generation", { method: "POST", body: { role: "builder", operator: "prompt_rewrite" } });
      expect(gen.status, gen.text).toBe(202);
      expect((await lockState(E))?.holder).toBe(`job:${gen.json.job_id}`);
      // while the generation job holds the lock, a second generation is refused
      expect((await api(cookie, "/api/evolution/generation", { method: "POST", body: { role: "builder" } })).status).toBe(409);
      const jg = await drainJob(E, gen.json.job_id);
      expect(jg.status, jg.error ?? "").toBe("done");
      expect(jg.chunks).toBeGreaterThanOrEqual(2); // one stage per chunk
      expect(["canary", "lost", "rejected"]).toContain((jg.result as any).outcome);
      expect((jg.result as any).proposal_id).toMatch(/^prop_/);
      expect(await lockState(E)).toBeNull();

      const t = await api(cookie, "/api/evolution/tick", { method: "POST", body: { roles: ["builder"], max_proposals: 0 } });
      expect(t.status).toBe(202);
      const jt = await drainJob(E, t.json.job_id);
      expect(jt.status, jt.error ?? "").toBe("done");
      expect(jt.result).toMatchObject({ status: "ok", generations: [] });
      expect(await lockState(E)).toBeNull();
    },
    T,
  );

  it("cancelling a queued generation job releases its lock", async () => {
    await seedStarterOrg(E);
    await plantItems();
    const cookie = await login();
    const gen = await api(cookie, "/api/evolution/generation", { method: "POST", body: { role: "builder" } });
    expect(gen.status).toBe(202);
    const c = await api(cookie, `/api/jobs/${gen.json.job_id}/cancel`, { method: "POST", body: {} });
    // the runner alarm may already have picked it up; either way the lock must end up free
    if (c.status === 200) {
      await drainJob(E, gen.json.job_id);
      for (let i = 0; i < 100 && (await lockState(E)); i++) await new Promise((r) => setTimeout(r, 50));
      expect(await lockState(E)).toBeNull();
    }
  });
});
