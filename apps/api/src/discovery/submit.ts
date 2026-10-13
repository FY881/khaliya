/**
 * Problem submission validation (ARCHITECTURE §17 "Human-in-the-loop").
 *
 * An owner- or agent-submitted problem is accepted only when its verifier is itself trustworthy:
 *   structure → static scan → known-good accepted → known-bad rejected (cleanly, no crash) → determinism
 *   (same verdict under different sandbox seeds) → robustness to fuzz garbage (never crashes, never blows
 *   its fuel) → budget headroom → seed program (if given) produces a valid solution.
 * Fail-fast like the Tool Forge: the first failing gate rejects; later gates are marked skipped.
 * validateProblemSubmission() is pure (sandbox only); submitProblem() persists through store.ts.
 */
import type { Env } from "../env";
import { staticScan } from "../forge/admission";
import { runVerifier, type VerifierResult } from "../forge/tool";
import type { ForgeToolSpec } from "../forge/types";
import { canonicalJson, now } from "../util";
import { evaluateProgram } from "./evolve";
import { getBuiltinProblem } from "./problems";
import { getProblemRow, upsertProblem, type ProblemRow } from "./store";
import type { BestKnownStatus, Direction, ProblemDef, ProblemLimits } from "./types";

export interface ProblemSubmission {
  id: string;
  title_en: string;
  title_ar?: string;
  statement_en: string;
  statement_ar?: string;
  direction: Direction;
  params?: Record<string, unknown>;
  instance: Record<string, unknown>;
  /** Guest JS declaring verify({solution, instance}) → {valid, score, detail} (or a boolean). */
  verifier: string;
  /** Optional guest JS declaring construct(input). Default: a program returning the first good example. */
  seed_program?: string;
  best_known?: { score: number | null; source: string; status?: BestKnownStatus };
  good: unknown[];
  bad: unknown[];
  /** owner | agent:<id> */
  author: string;
  limits?: ProblemLimits;
  family?: string;
}

export type SubmitGate = "structure" | "static" | "good" | "bad" | "determinism" | "fuzz" | "budget" | "seed";
export const SUBMIT_GATES: SubmitGate[] = ["structure", "static", "good", "bad", "determinism", "fuzz", "budget", "seed"];

export interface SubmitGateResult {
  gate: SubmitGate;
  pass: boolean;
  skipped?: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface SubmissionReport {
  status: "accepted" | "rejected";
  reason?: string;
  gates: SubmitGateResult[];
  warnings: string[];
  stats: { runs: number; maxFuel: number; maxMs: number };
  at: number;
}

export const SUBMIT_LIMITS = Object.freeze({
  minGood: 2,
  minBad: 2,
  maxExamples: 20,
  maxVerifierBytes: 32 * 1024,
  maxInstanceBytes: 64 * 1024,
  maxExampleBytes: 64 * 1024,
  verifyFuel: 300,
  /** Peak fuel of any validation run must stay under this share of the verifier fuel limit. */
  fuelHeadroom: 0.8,
});

const ID_RE = /^[a-z][a-z0-9-]{2,47}$/;
const enc = new TextEncoder();
const bytes = (v: unknown) => {
  try {
    return enc.encode(JSON.stringify(v) ?? "").length;
  } catch {
    return Infinity;
  }
};

export function submissionStructureProblems(s: ProblemSubmission): string[] {
  const e: string[] = [];
  if (!s || typeof s !== "object") return ["submission must be an object"];
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) e.push("id: lowercase slug, 3–48 chars [a-z0-9-]");
  else if (getBuiltinProblem(s.id)) e.push("id: collides with a built-in problem");
  if (typeof s.title_en !== "string" || s.title_en.trim().length < 3) e.push("title_en: at least 3 chars");
  if (typeof s.statement_en !== "string" || s.statement_en.trim().length < 20) e.push("statement_en: at least 20 chars");
  if (s.direction !== "max" && s.direction !== "min") e.push("direction: 'max' or 'min'");
  if (!s.instance || typeof s.instance !== "object" || Array.isArray(s.instance)) e.push("instance: a JSON object");
  else if (bytes(s.instance) > SUBMIT_LIMITS.maxInstanceBytes) e.push(`instance: larger than ${SUBMIT_LIMITS.maxInstanceBytes} bytes`);
  if (typeof s.verifier !== "string" || !s.verifier.trim()) e.push("verifier: required");
  else if (enc.encode(s.verifier).length > SUBMIT_LIMITS.maxVerifierBytes) e.push(`verifier: larger than ${SUBMIT_LIMITS.maxVerifierBytes} bytes`);
  if (s.seed_program !== undefined && (typeof s.seed_program !== "string" || !/function\s+construct\s*\(/.test(s.seed_program))) e.push("seed_program: must declare function construct(input)");
  for (const k of ["good", "bad"] as const) {
    const min = k === "good" ? SUBMIT_LIMITS.minGood : SUBMIT_LIMITS.minBad;
    const xs = s[k];
    if (!Array.isArray(xs) || xs.length < min) e.push(`${k}: at least ${min} known-${k} solutions`);
    else if (xs.length > SUBMIT_LIMITS.maxExamples) e.push(`${k}: at most ${SUBMIT_LIMITS.maxExamples}`);
    else if (xs.some((x) => bytes(x) > SUBMIT_LIMITS.maxExampleBytes)) e.push(`${k}: each example at most ${SUBMIT_LIMITS.maxExampleBytes} bytes of JSON`);
    else if (new Set(xs.map((x) => canonicalJson(x))).size !== xs.length) e.push(`${k}: examples must be distinct`);
  }
  if (Array.isArray(s.good) && Array.isArray(s.bad)) {
    const goods = new Set(s.good.map((x) => canonicalJson(x)));
    if (s.bad.some((x) => goods.has(canonicalJson(x)))) e.push("good/bad: the same solution is listed as both good and bad");
  }
  if (s.best_known) {
    const sc = s.best_known.score;
    if (sc !== null && (typeof sc !== "number" || !Number.isFinite(sc))) e.push("best_known.score: a finite number or null");
    if (sc !== null && (typeof s.best_known.source !== "string" || s.best_known.source.trim().length < 5)) e.push("best_known.source: cite where the value comes from");
  }
  if (typeof s.author !== "string" || !/^(owner|agent:[\w.-]+|system:[\w.-]+)$/.test(s.author)) e.push("author: owner | agent:<id> | system:<x>");
  return e;
}

/** Garbage solutions every verifier must survive (no crash, no budget blow-up). */
export function garbageSolutions(goods: unknown[]): { value: unknown; mutated: boolean }[] {
  let deep: unknown = 0;
  for (let i = 0; i < 60; i++) deep = [deep];
  const g: unknown[] = [
    null,
    0,
    -1,
    1e308,
    -0.5,
    "",
    "garbage",
    "x".repeat(10_000),
    true,
    [],
    [null],
    [[]],
    [{}],
    {},
    JSON.parse('{"__proto__":{"valid":true}}'),
    { length: 1e9 },
    { valid: true, score: 1e9 },
    deep,
    Array.from({ length: 5000 }, (_, i) => i),
    Array.from({ length: 300 }, () => "a"),
    [1e308, -1e308, 0.1],
  ];
  const out = g.map((value) => ({ value, mutated: false }));
  for (const x of goods.slice(0, 4)) {
    if (Array.isArray(x) && x.length) {
      out.push({ value: x.slice(0, -1), mutated: true });
      out.push({ value: [...x, x[0]], mutated: true });
      out.push({ value: x.map((v, i) => (i === 0 ? "x" : v)), mutated: true });
      out.push({ value: x.map((v) => (typeof v === "number" ? v + 0.5 : v)), mutated: true });
    } else if (x && typeof x === "object") out.push({ value: Object.fromEntries(Object.keys(x).map((k) => [k, null])), mutated: true });
    else out.push({ value: typeof x === "number" ? x + 0.5 : String(x) + "?", mutated: true });
  }
  return out;
}

export function defaultSeedProgram(firstGood: unknown): string {
  return `// Default seed: returns the first known-good solution. Evolution improves from here.\nvar EXAMPLE = ${JSON.stringify(firstGood)};\n\nfunction construct(input) {\n  return EXAMPLE;\n}`;
}

export function submissionToDef(s: ProblemSubmission): ProblemDef {
  return {
    id: s.id,
    family: s.family ?? "submitted",
    title_en: s.title_en,
    title_ar: s.title_ar ?? s.title_en,
    statement_en: s.statement_en,
    statement_ar: s.statement_ar ?? s.statement_en,
    direction: s.direction,
    params: s.params ?? {},
    instance: s.instance,
    verifier: s.verifier,
    seed_program: s.seed_program ?? defaultSeedProgram(s.good[0]),
    best_known: { score: s.best_known?.score ?? null, status: s.best_known?.status ?? "unverified", source: s.best_known?.source ?? "not given by the submitter" },
    examples: { good: s.good, bad: s.bad },
    limits: s.limits,
    source: s.author,
  };
}

export interface ValidateDeps {
  /** Verifier fuel used for validation runs (default 300, clamped by the sandbox's hard limit). */
  verifyFuel?: number;
  runner?: typeof runVerifier;
}

export async function validateProblemSubmission(s: ProblemSubmission, deps: ValidateDeps = {}): Promise<SubmissionReport> {
  const gates: SubmitGateResult[] = [];
  const warnings: string[] = [];
  const stats = { runs: 0, maxFuel: 0, maxMs: 0 };
  const verifyFuel = deps.verifyFuel ?? s?.limits?.verifyFuel ?? SUBMIT_LIMITS.verifyFuel;
  const run = deps.runner ?? runVerifier;
  const verify = async (solution: unknown, seed = 1): Promise<VerifierResult> => {
    const r = await run(s.verifier, solution, { instance: s.instance, seed, limits: { fuel: verifyFuel, maxInputBytes: 256 * 1024 } });
    stats.runs++;
    stats.maxFuel = Math.max(stats.maxFuel, r.fuelUsed);
    stats.maxMs = Math.max(stats.maxMs, r.ms);
    return r;
  };
  const finish = (reason?: string): SubmissionReport => {
    const done = new Set(gates.map((g) => g.gate));
    for (const g of SUBMIT_GATES) if (!done.has(g)) gates.push({ gate: g, pass: false, skipped: true });
    return { status: reason ? "rejected" : "accepted", reason, gates, warnings, stats, at: now() };
  };
  const fail = (gate: SubmitGate, reason: string, detail?: Record<string, unknown>) => {
    gates.push({ gate, pass: false, reason, detail });
    return finish(`${gate}: ${reason}`);
  };

  // 1. structure
  const sp = submissionStructureProblems(s);
  if (sp.length) return fail("structure", sp.join("; "), { problems: sp });
  gates.push({ gate: "structure", pass: true });

  // 2. static scan (same rules as forged tools; entry = verify)
  const scan = staticScan({ code: s.verifier, entry: "verify" } as ForgeToolSpec);
  warnings.push(...scan.warnings.map((w) => `verifier: ${w}`));
  if (scan.hard.length) return fail("static", scan.hard.join("; "));
  gates.push({ gate: "static", pass: true });

  // 3. known-good accepted
  const goodRes: VerifierResult[] = [];
  for (let i = 0; i < s.good.length; i++) {
    const r = await verify(s.good[i]);
    goodRes.push(r);
    if (r.errorKind) return fail("good", `verifier crashed on good #${i}: ${r.detail}`);
    if (!r.valid) return fail("good", `verifier rejected good #${i}: ${r.detail ?? "invalid"}`);
    if (!Number.isFinite(r.score)) return fail("good", `non-finite score on good #${i}`);
  }
  gates.push({ gate: "good", pass: true, detail: { scores: goodRes.map((r) => r.score) } });

  // 4. known-bad rejected (cleanly: a crash is not a rejection)
  const badRes: VerifierResult[] = [];
  for (let i = 0; i < s.bad.length; i++) {
    const r = await verify(s.bad[i]);
    badRes.push(r);
    if (r.errorKind) return fail("bad", `verifier crashed on bad #${i} (${r.errorKind}): it must return {valid:false}`);
    if (r.valid) return fail("bad", `verifier accepted bad #${i} (score ${r.score})`);
  }
  gates.push({ gate: "bad", pass: true });

  // 5. determinism: same verdict under two other seeds
  const probe = [...s.good.map((x, i) => ({ x, ref: goodRes[i] })), ...s.bad.slice(0, 2).map((x, i) => ({ x, ref: badRes[i] }))];
  for (const seed of [7, 1_000_003]) {
    for (const p of probe) {
      const r = await verify(p.x, seed);
      if (r.valid !== p.ref.valid || r.score !== p.ref.score || (r.detail ?? "") !== (p.ref.detail ?? "")) return fail("determinism", `verdict changed under sandbox seed ${seed} (valid ${p.ref.valid}→${r.valid}, score ${p.ref.score}→${r.score})`);
    }
  }
  gates.push({ gate: "determinism", pass: true });

  // 6. garbage fuzz: never crash, never exceed the budget
  let acceptedGarbage = 0;
  for (const { value, mutated } of garbageSolutions(s.good)) {
    const r = await verify(value);
    if (r.errorKind) return fail("fuzz", `verifier ${r.errorKind} on garbage ${JSON.stringify(value)?.slice(0, 80)}: ${r.detail}`);
    if (r.valid && !mutated) acceptedGarbage++;
  }
  if (acceptedGarbage) warnings.push(`verifier accepted ${acceptedGarbage} garbage input(s) as valid; check the solution format is enforced`);
  gates.push({ gate: "fuzz", pass: true, detail: { acceptedGarbage } });

  // 7. budget headroom
  if (stats.maxFuel > verifyFuel * SUBMIT_LIMITS.fuelHeadroom) return fail("budget", `peak fuel ${stats.maxFuel} is over ${Math.round(SUBMIT_LIMITS.fuelHeadroom * 100)}% of the ${verifyFuel} limit`);
  gates.push({ gate: "budget", pass: true, detail: { maxFuel: stats.maxFuel, verifyFuel } });

  // 8. the seed program must produce a valid solution
  const def = submissionToDef(s);
  const ev = await evaluateProgram(def, def.seed_program, { seed: 1, verifyFuel });
  stats.runs += 2;
  if (!ev.valid) return fail("seed", `seed program does not produce a valid solution: ${ev.error ?? "invalid"}`);
  if (!s.seed_program) warnings.push("no seed program given: the default seed returns the first good example");
  gates.push({ gate: "seed", pass: true, detail: { score: ev.score } });

  if (s.best_known?.score !== undefined && s.best_known.score !== null) {
    const bk = s.best_known.score;
    const bestGood = goodRes.reduce((a, r) => (s.direction === "max" ? Math.max(a, r.score) : Math.min(a, r.score)), s.direction === "max" ? -Infinity : Infinity);
    if (s.direction === "max" ? bestGood > bk : bestGood < bk) warnings.push(`a known-good example (${bestGood}) already beats the stated best known (${bk}); check the citation`);
  }
  return finish();
}

export interface SubmitProblemResult {
  status: "accepted" | "rejected";
  report: SubmissionReport;
  problem?: ProblemRow;
}

/** Validate and persist. Accepted problems become active; a rejected one is stored for audit only if the id is free. */
export async function submitProblem(env: Env, s: ProblemSubmission, deps: ValidateDeps = {}): Promise<SubmitProblemResult> {
  const report = await validateProblemSubmission(s, deps);
  const existing = typeof s?.id === "string" ? await getProblemRow(env, s.id) : null;
  if (report.status === "rejected") {
    if (!existing && typeof s?.id === "string" && ID_RE.test(s.id) && !report.gates.find((g) => g.gate === "structure" && !g.pass)) {
      const problem = await upsertProblem(env, submissionToDef(s), { status: "rejected", validation: report });
      return { status: "rejected", report, problem };
    }
    return { status: "rejected", report };
  }
  if (existing && existing.source !== s.author) {
    report.status = "rejected";
    report.reason = `structure: id '${s.id}' already belongs to ${existing.source}`;
    return { status: "rejected", report };
  }
  const problem = await upsertProblem(env, submissionToDef(s), { status: "active", validation: report });
  return { status: "accepted", report, problem };
}
