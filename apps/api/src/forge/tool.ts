/**
 * Gateway adapter for forged tools + the generic verifier runner (reused by the Discovery Lab, §17).
 *
 * Wired into ToolGateway: a `forge.*` id that is not a built-in tool is looked up here (forgeToolDef), so the
 * gateway's kill switch / genome grant / tier / budget / audit path stays the ONLY way an agent reaches a
 * forged tool. Execution always goes through the sandbox, with the plan's fuel cap (env FORGE_FUEL_CAP).
 */
import type { Tier } from "../constitution";
import type { Env } from "../env";
import { schemaErrors } from "../eval/checkers";
import type { JsonSchema } from "../eval/types";
import type { ToolContext, ToolDef } from "../tools/catalog";
import { sha256Hex } from "../util";
import { effectiveLimits } from "./admission";
import { runSandboxed, type SandboxLimits, type SandboxResult } from "./sandbox";
import { getAdmittedTool, listAdmittedTools, recordForgeRun, successRate, type ForgeToolRow } from "./store";

export const FORGE_TIER: Tier = 1;
/** Genome grant that covers every admitted forged tool. */
export const FORGE_WILDCARD = "forge.*";

/** Plan fuel cap for forged-tool runs (FORGE_FUEL_CAP var; unset/0 = the tool's own limit). */
export function forgeFuelCap(env: Pick<Env, "FORGE_FUEL_CAP">): number | null {
  const n = Number(env.FORGE_FUEL_CAP ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Does a genome's tool list grant `toolId` (exact id, or the forge.* wildcard for forged tools)? */
export function grantsTool(genomeToolIds: string[], toolId: string): boolean {
  return genomeToolIds.includes(toolId) || (toolId.startsWith("forge.") && genomeToolIds.includes(FORGE_WILDCARD));
}

export interface ForgeCatalogEntry {
  id: string;
  name: string;
  tier: Tier;
  description: string;
  schema: ToolDef["schema"];
  forge: { tool_id: string; version: number; hash: string; author: string; uses: number; success_rate: number | null };
}

function catalogSchema(s: JsonSchema): ToolDef["schema"] {
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [k, v] of Object.entries(s.properties ?? {})) properties[k] = { type: v.type ?? "any" };
  return { required: s.required ?? [], properties };
}

export function toCatalogEntry(t: ForgeToolRow): ForgeCatalogEntry {
  return {
    id: t.name,
    name: t.name,
    tier: FORGE_TIER,
    description: `${t.spec.description} (forged tool v${t.version}, sandboxed)`,
    schema: catalogSchema(t.spec.input_schema),
    forge: { tool_id: t.id, version: t.version, hash: t.hash, author: t.author, uses: t.uses, success_rate: successRate(t) },
  };
}

/** (a) Admitted forge tools as catalog-style entries (tier T1), newest version per name. */
export async function listForgeCatalog(env: Env): Promise<ForgeCatalogEntry[]> {
  return (await listAdmittedTools(env)).map(toCatalogEntry);
}

function defOf(e: ForgeCatalogEntry): ToolDef {
  return {
    id: e.id,
    name: e.name,
    tier: e.tier,
    description: e.description,
    schema: e.schema,
    handler: async (ctx: ToolContext, args: Record<string, any>) => {
      const r = await executeForgeTool(ctx.env, e.id, args, { caller: `agent:${ctx.agentId}`, run_id: ctx.runId, version: e.forge.version });
      if (!r.ok) throw new Error(r.error ?? "forge tool failed");
      return r.value;
    },
  };
}

/** The same entries as full ToolDefs (handler runs the sandbox), ready to merge into the gateway's lookup. */
export async function forgeToolDefs(env: Env): Promise<ToolDef[]> {
  return (await listForgeCatalog(env)).map(defOf);
}

/** One admitted forged tool as a ToolDef (null when no admitted version exists). */
export async function forgeToolDef(env: Env, name: string): Promise<ToolDef | null> {
  if (!name.startsWith("forge.") || name === FORGE_WILDCARD) return null;
  const t = await getAdmittedTool(env, name);
  return t ? defOf(toCatalogEntry(t)) : null;
}

/** Prompt lines describing the forged tools a genome may call (exact grants + wildcard). */
export async function describeForgeTools(env: Env, genomeToolIds: string[]): Promise<string> {
  if (!genomeToolIds.some((t) => t.startsWith("forge.") && t !== "forge.submit")) return "";
  const all = await listForgeCatalog(env);
  return all
    .filter((e) => grantsTool(genomeToolIds, e.id))
    .map((e) => `- ${e.id} (T${e.tier}): ${e.description} args: ${JSON.stringify(Object.keys(e.schema.properties))}`)
    .join("\n");
}

export interface ForgeExecOptions {
  caller?: string;
  run_id?: string;
  version?: number;
  /** Write a forge_runs row + bump usage counters (default true). */
  record?: boolean;
  /** Fuel cap override (default: env FORGE_FUEL_CAP; null = the tool's own limit). */
  fuelCap?: number | null;
}

export interface ForgeExecResult {
  ok: boolean;
  tool: string;
  version?: number;
  value?: unknown;
  error?: string;
  errorKind?: string;
  ms: number;
  fuelUsed: number;
}

/** (b) Execute an admitted forge tool in the sandbox with its stored limits. Never throws for tool errors. */
export async function executeForgeTool(env: Env, name: string, args: unknown, o: ForgeExecOptions = {}): Promise<ForgeExecResult> {
  const t = await getAdmittedTool(env, name, o.version);
  if (!t) return { ok: false, tool: name, error: `no admitted forge tool '${name}'`, errorKind: "unknown_tool", ms: 0, fuelUsed: 0 };
  const base = { tool: name, version: t.version };
  const inErr = schemaErrors(args ?? {}, t.spec.input_schema);
  if (inErr.length) return { ...base, ok: false, error: `invalid args: ${inErr.slice(0, 3).join("; ")}`, errorKind: "invalid_args", ms: 0, fuelUsed: 0 };
  const r = await runSandboxed({ code: t.code, entry: t.spec.entry ?? "run", input: args ?? {}, limits: effectiveLimits(t.spec.limits, o.fuelCap === undefined ? forgeFuelCap(env) : o.fuelCap) });
  let out: ForgeExecResult = r.ok
    ? { ...base, ok: true, value: r.value, ms: r.ms, fuelUsed: r.fuelUsed }
    : { ...base, ok: false, error: r.error, errorKind: r.errorKind, ms: r.ms, fuelUsed: r.fuelUsed };
  if (r.ok && t.spec.output_schema) {
    const oe = schemaErrors(r.value, t.spec.output_schema);
    if (oe.length) out = { ...base, ok: false, error: `output violates schema: ${oe[0]}`, errorKind: "bad_output", ms: r.ms, fuelUsed: r.fuelUsed };
  }
  if (o.record !== false)
    await recordForgeRun(env, {
      tool_id: t.id,
      context: "call",
      caller: o.caller ?? null,
      run_id: o.run_id ?? null,
      ok: out.ok,
      error_kind: out.errorKind ?? null,
      ms: r.ms,
      fuel_used: r.fuelUsed,
      output_bytes: r.outputBytes,
    });
  return out;
}

// ---------------- verifier runner (Discovery Lab) ----------------
export interface VerifierOptions {
  /** Problem instance passed alongside the solution (e.g. {n: 5}). */
  instance?: unknown;
  /** Global function in `code` called as verify({solution, instance}). Default "verify". */
  entry?: string;
  limits?: SandboxLimits;
  seed?: number;
}

export interface VerifierResult {
  valid: boolean;
  /** Problem-defined score (finite number; 0 when invalid or not given). */
  score: number;
  detail?: string;
  /** sha256 of the verifier code (goes on every certificate). */
  verifierHash: string;
  ms: number;
  fuelUsed: number;
  errorKind?: string;
}

const VERIFIER_DEFAULT_LIMITS: SandboxLimits = { fuel: 5_000, timeMs: 2_000, memoryBytes: 32 * 1024 * 1024, maxOutputBytes: 4 * 1024 };

export const verifierHash = (code: string) => sha256Hex(`verifier\n${code}`);

/**
 * Run a deterministic verifier on a candidate solution inside the sandbox.
 * The verifier returns `true|false` or `{valid, score?, detail?}`. Any crash, budget blow-up or malformed
 * reply is reported as invalid (never as a pass).
 */
export async function runVerifier(code: string, solution: unknown, o: VerifierOptions = {}): Promise<VerifierResult> {
  const vh = await verifierHash(code);
  const r: SandboxResult = await runSandboxed({
    code,
    entry: o.entry ?? "verify",
    input: { solution, instance: o.instance ?? null },
    limits: { ...VERIFIER_DEFAULT_LIMITS, ...(o.limits ?? {}), seed: o.seed ?? 1 },
  });
  const meta = { verifierHash: vh, ms: r.ms, fuelUsed: r.fuelUsed };
  if (!r.ok) return { ...meta, valid: false, score: 0, detail: `verifier ${r.errorKind}: ${r.error}`, errorKind: r.errorKind };
  const v = r.value as unknown;
  if (typeof v === "boolean") return { ...meta, valid: v, score: v ? 1 : 0 };
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { valid?: unknown }).valid === "boolean") {
    const x = v as { valid: boolean; score?: unknown; detail?: unknown };
    const score = typeof x.score === "number" && Number.isFinite(x.score) ? x.score : x.valid ? 1 : 0;
    return { ...meta, valid: x.valid, score: x.valid ? score : 0, detail: x.detail === undefined ? undefined : String(x.detail).slice(0, 500) };
  }
  return { ...meta, valid: false, score: 0, detail: "verifier must return a boolean or {valid, score?, detail?}", errorKind: "bad_result" };
}
