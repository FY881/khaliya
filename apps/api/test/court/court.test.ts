import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { LabLLM, MOCK_JUDGES } from "../../src/eval/llm";
import { HANDLERS } from "../../src/jobs/handlers";
import { drainJob } from "../../src/jobs/runner";
import { createJob } from "../../src/jobs/store";
import { Governor } from "../../src/governor/governor";
import { coverage, PROBE_BANK } from "../../src/court/bank";
import { P5_JOB_HANDLERS } from "../../src/court/handlers";
import { courtProbeInit, COURT_PROBE_KIND } from "../../src/court/jobs";
import { judgeFamily, parseGenerated, planUnits, runUnit } from "../../src/court/probe";
import { mountCourtRoutes } from "../../src/court/routes";
import { courtGate, courtWeights, latestRecords, refreshScores, scoreJudge, weightedJudgeScore } from "../../src/court/score";
import { cohenKappa, createSpotCheck, insertProbeRows, kappaByJudge, labelSpotCheck, listSpotChecks, upsertSpotCheck } from "../../src/court/store";
import { freshState } from "../helpers";

const E = env as unknown as Env;
const lab = (n = 60) => new LabLLM(E, { maxCalls: n, share: 0.3 });
const [JA, JB] = MOCK_JUDGES; // judge-a: position-biased on ties by design; judge-b: unbiased

beforeAll(() => {
  Object.assign(HANDLERS, P5_JOB_HANDLERS);
});
beforeEach(freshState);

describe("pure pieces", () => {
  it("Cohen's kappa", () => {
    expect(cohenKappa([])).toBeNull();
    expect(cohenKappa([["A", "A"], ["B", "B"], ["tie", "tie"]])).toBe(1);
    expect(cohenKappa([["A", "A"], ["A", "A"]])).toBe(1);
    expect(cohenKappa([["A", "B"], ["B", "A"]])).toBeLessThan(0);
    // classic 2x2: po = 0.7, pe = 0.5 → 0.4
    const pairs: [string, string][] = [...Array(4).fill(["A", "A"]), ...Array(3).fill(["B", "B"]), ...Array(2).fill(["A", "B"]), ["B", "A"]];
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 3);
  });

  it("families, plans, bank integrity", () => {
    expect(judgeFamily("gemini:gemini-3.5-flash")).toBe("gemini");
    expect(judgeFamily("openrouter:meta-llama/llama-3.3-70b-instruct:free")).toBe("llama");
    expect(judgeFamily("workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct")).toBe("llama");
    expect(judgeFamily("openrouter:deepseek/deepseek-chat-v3-0324:free")).toBe("deepseek");
    expect(judgeFamily(JA)).not.toBe(judgeFamily(JB));
    const units = planUnits([JA, JB], ["position", "verbosity", "gold", "lang", "self_pref"], 3, 6);
    expect(units).toHaveLength(12);
    expect(new Set(units.map((u) => u.kind)).size).toBe(5);
    expect(new Set(units.map((u) => u.lang))).toEqual(new Set(["en", "ar"]));
    expect(planUnits(["gemini:a", "gemini:b"], ["self_pref"], 0)).toHaveLength(0); // one family → no self-pref
    for (const p of PROBE_BANK)
      for (const l of ["en", "ar"] as const) {
        expect(coverage(p.good[l], p.criteria[l])).toBe(1);
        expect(coverage(p.good2[l], p.criteria[l])).toBe(1);
        expect(coverage(p.weak[l], p.criteria[l])).toBe(0);
      }
    expect(parseGenerated('{"answer": "x"}')).toBe("x");
    expect(parseGenerated('{"thought": "t", "final": "y"}')).toBe("y");
  });

  it("scoreJudge benches a position-biased judge and certifies a clean one", () => {
    const row = (probe: string, consistent: number, outcome: number | null, lang: "en" | "ar" = "en", item = "x", verdict = "X", job = "j") => ({ probe, lang, item_key: `${probe}:${item}`, verdict, consistent, outcome, job_id: job, at: 1 });
    const biased = [...[0, 0, 0, 1].map((c) => row("position", c, 0.5)), ...[1, 1, 1].map((o) => row("gold", 1, o))];
    const b = scoreJudge("j:a", biased, undefined);
    expect(b.benched).toBe(true);
    expect(b.weight).toBe(0);
    expect(b.position_consistency).toBe(0.25);
    const clean = [
      ...[1, 1, 1, 1].map((c) => row("position", c, 0.5)),
      ...[1, 1, 1].map((o) => row("gold", 1, o)),
      ...[0.5, 0.5, 0.5].map((o) => row("self_pref", 1, o)),
      ...[0.5, 0.5, 0.5].map((o) => row("verbosity", 1, o)),
      ...["a", "b", "c"].flatMap((i) => [row("lang", 1, 1, "en", i, "X", `j${i}`), row("lang", 1, 1, "ar", i, "X", `j${i}`)]),
    ];
    const c = scoreJudge("j:b", clean, { judge: "j:b", en: { kappa: 0.8, n: 5 }, ar: { kappa: 0.7, n: 4 } });
    expect(c).toMatchObject({ benched: false, certified: true, lang_consistency: 1, verbosity_bias: 0, self_pref_rate: 0.5, kappa_en: 0.8, kappa_ar: 0.7 });
    expect(c.reliability).toBeGreaterThan(0.9);
    const ar = scoreJudge("j:c", [...clean.filter((r) => r.probe !== "lang"), ...["a", "b", "c"].flatMap((i) => [row("lang", 1, 1, "en", i, "X", `k${i}`), row("lang", 1, 0, "ar", i, "Y", `k${i}`)])], undefined);
    expect(ar.lang_consistency).toBe(0);
    expect(ar.benched).toBe(true);
    expect(ar.gold_accuracy_ar).toBe(0);
  });
});

describe("probes against the deterministic mock judges", () => {
  it("position: judge-a flips with order, judge-b is order-stable (EN and AR)", async () => {
    for (const lang of ["en", "ar"] as const) {
      const a = await runUnit(lab(), { judge: JA, kind: "position", item: "backup", lang }, [JA, JB]);
      expect(a.rows[0]).toMatchObject({ ab: "X", ba: "Y", consistent: false, verdict: "draw", lang });
      const b = await runUnit(lab(), { judge: JB, kind: "position", item: "backup", lang }, [JA, JB]);
      expect(b.rows[0]).toMatchObject({ ab: "tie", ba: "tie", consistent: true, verdict: "draw" });
    }
  });

  it("gold + lang: both judges pick the right answer in English and Arabic; verbosity padding never wins", async () => {
    const L = lab();
    const g = await runUnit(L, { judge: JB, kind: "lang", item: "photosynthesis", lang: "ar" }, [JA, JB]);
    expect(g.rows.map((r) => [r.lang, r.verdict])).toEqual([["ar", "X"], ["en", "X"]]);
    const v = await runUnit(L, { judge: JA, kind: "verbosity", item: "water", lang: "ar" }, [JA, JB]);
    expect(v.rows[0].outcome).toBe(0.5);
    expect(L.calls).toBe(6);
  });

  it("self-preference: generates own + foreign answers, keeps only equal-quality pairs", async () => {
    const L = lab();
    const s = await runUnit(L, { judge: JA, kind: "self_pref", item: "sleep", lang: "en" }, [JA, JB]);
    expect(L.calls).toBeLessThanOrEqual(4); // identical pairs replay from the D1 cache (not counted)
    expect(s.rows[0]).toMatchObject({ probe: "self_pref", outcome: 0.5, item_key: `self_pref:sleep:${JA}` });
    expect((s.rows[0].detail as any).foreign).toBe(JB);
  });

  it("a pinned judge that is not available is skipped, not fatal", async () => {
    const auto = { ...E, LLM_MODE: "auto", GEMINI_KEY: undefined, OPENROUTER_KEY: undefined } as Env;
    const r = await runUnit(new LabLLM(auto, { maxCalls: 5, share: 0.3 }), { judge: "gemini:gemini-3.5-flash", kind: "gold", item: "backup", lang: "en" }, []);
    expect(r.rows).toHaveLength(0);
    expect(r.error).toBeTruthy();
  });
});

describe("court.probe job → reliability records → weights / gate", () => {
  it("runs in chunks within budget, benches judge-a, keeps judge-b", async () => {
    const init = courtProbeInit([JA, JB], { per_judge: 15, seed: 1 });
    const job = await createJob(E, { kind: COURT_PROBE_KIND, params: {}, state: init.state, total: init.total, max_calls: 120 });
    const done = await drainJob(E, job.id);
    expect(done.status).toBe("done");
    expect(done.chunks).toBeGreaterThan(1); // ≤ 12 calls per chunk
    expect(done.llm_calls).toBeLessThanOrEqual(120);
    const res = done.result as any;
    expect(res.rows).toBeGreaterThanOrEqual(20);
    const recs = await latestRecords(E);
    const a = recs.find((r) => r.judge_model === JA)!;
    const b = recs.find((r) => r.judge_model === JB)!;
    expect(a.position_consistency).toBe(0);
    expect(a.benched).toBe(true);
    expect(b.position_consistency).toBe(1);
    expect(b.benched).toBe(false);
    expect(b.weight).toBeGreaterThan(0.5);
    const w = await courtWeights(E, [JA, JB, "gemini:unknown"]);
    expect(w[JA].weight).toBe(0);
    expect(w["gemini:unknown"]).toMatchObject({ weight: 1, known: false });
    expect(weightedJudgeScore([{ model: JA, score: 1 }, { model: JB, score: 0.2 }], w)).toBe(0.2);
    const gate = await courtGate(E, [JA, JB]);
    expect(gate.ok).toBe(false);
    expect(gate.eligible).toEqual([JB]);
  });

  it("stops cleanly on the job budget and still records what it measured", async () => {
    const init = courtProbeInit([JA, JB], { per_judge: 10, kinds: ["position", "gold"] });
    const job = await createJob(E, { kind: COURT_PROBE_KIND, params: {}, state: init.state, total: init.total, max_calls: 6 });
    const done = await drainJob(E, job.id);
    expect(done.status).toBe("done");
    expect(done.stopped).toBe("budget");
    expect((await latestRecords(E)).length).toBeGreaterThan(0);
  });

  it("is stopped by the global kill switch", async () => {
    await new Governor(E).setKill("global", true);
    const init = courtProbeInit([JA, JB]);
    const job = await createJob(E, { kind: COURT_PROBE_KIND, params: {}, state: init.state, total: init.total, max_calls: 40 });
    const done = await drainJob(E, job.id);
    expect(done.stopped).toBe("killed");
    expect(done.llm_calls).toBe(0);
  });
});

describe("owner spot-checks and kappa", () => {
  it("disagreement rows open spot-checks; labels feed kappa per language", async () => {
    const answers = { task: "t", criteria: [], x: "good answer.", y: "bad answer." };
    const base = { judge_family: "f", probe: "gold" as const, item_key: "gold:t", ab: "X" as const, ba: "X" as const, consistent: true, outcome: 1, answers };
    const id = await upsertSpotCheck(E, { ...base, judge_model: JA, lang: "en", verdict: "X" }, "judges disagree");
    await upsertSpotCheck(E, { ...base, judge_model: JB, lang: "en", verdict: "Y" }, "judges disagree");
    const ar = await upsertSpotCheck(E, { ...base, judge_model: JA, lang: "ar", verdict: "Y" }, "judge missed the gold answer");
    expect(id).toBeTruthy();
    const open = await listSpotChecks(E, { status: "open" });
    expect(open).toHaveLength(2);
    expect(open.find((s) => s.id === id)!.judge_verdicts).toEqual({ [JA]: "A", [JB]: "B" });
    await labelSpotCheck(E, id!, "A");
    await labelSpotCheck(E, ar!, "A");
    const k = await kappaByJudge(E);
    expect(k[JA].en.n).toBe(1);
    expect(k[JA].ar.n).toBe(1);
    expect(k[JB].en.n).toBe(1);
    expect(k[JB].ar.n).toBe(0);
    const man = await createSpotCheck(E, { lang: "ar", task: "س", answer_a: "أ", answer_b: "ب", judge_verdicts: { [JB]: "tie" } });
    expect(man.status).toBe("open");
    await insertProbeRows(E, [{ ...base, judge_model: JB, lang: "en", verdict: "X" }], null);
    const recs = await refreshScores(E, [JB]);
    expect(recs[0].n_labels).toBe(1);
  });
});

describe("routes (mounted on a bare app)", () => {
  const app = new Hono<any>();
  mountCourtRoutes(app);
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(path, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, E);
    return { status: res.status, json: (await res.json()) as any };
  };

  it("probe → 202 job; judges; spot-checks create/label; weights", async () => {
    expect((await call("/api/court/probe", { method: "POST", body: { kinds: ["nope"] } })).status).toBe(400);
    expect((await call("/api/court/probe", { method: "POST", body: { judges: ["gemini:not-usable"] } })).status).toBe(400);
    const p = await call("/api/court/probe", { method: "POST", body: { per_judge: 15, max_calls: 120 } });
    expect(p.status).toBe(202);
    expect(p.json.job.kind).toBe("court.probe");
    expect(p.json.poll).toBe(`/api/jobs/${p.json.job_id}`);
    const again = await call("/api/court/probe", { method: "POST", body: {} });
    expect(again.status).toBe(202);
    expect(again.json).toMatchObject({ reused: true, job_id: p.json.job_id }); // one active probe job at a time
    expect((await drainJob(E, p.json.job_id)).status).toBe("done");
    const j = await call("/api/court/judges");
    expect(j.status).toBe(200);
    expect(j.json.judges.map((x: any) => x.model)).toEqual(expect.arrayContaining([JA, JB]));
    expect(j.json.judges.find((x: any) => x.model === JA).record.benched).toBe(true);
    expect(j.json.targets.position).toBe(0.9);
    const created = await call("/api/court/spotchecks", { method: "POST", body: { lang: "ar", task: "أيهما أفضل؟", answer_a: "إجابة أ.", answer_b: "إجابة ب.", judge_verdicts: { [JA]: "A", [JB]: "B" } } });
    expect(created.status).toBe(201);
    expect((await call("/api/court/spotchecks", { method: "POST", body: { id: created.json.spotcheck.id, label: "C" } })).status).toBe(400);
    expect((await call("/api/court/spotchecks", { method: "POST", body: { id: "spot_nope", label: "A" } })).status).toBe(404);
    const lab1 = await call("/api/court/spotchecks", { method: "POST", body: { id: created.json.spotcheck.id, label: "B" } });
    expect(lab1.json.spotcheck).toMatchObject({ status: "labelled", owner_label: "B" });
    expect(lab1.json.kappa[JB].ar.n).toBe(1);
    const list = await call("/api/court/spotchecks?status=labelled");
    expect(list.json.spotchecks.length).toBeGreaterThanOrEqual(1);
    expect(typeof list.json.open).toBe("number");
    const w = await call(`/api/court/weights?models=${encodeURIComponent(`${JA},${JB}`)}`);
    expect(w.json.weights[JA].benched).toBe(true);
    expect(w.json.gate.ok).toBe(false);
  });
});
