/**
 * Studio service invocation — the ONE way a promoted Studio service genome answers a person (security wave 2026-10-16).
 *
 *   resolveService(env, slug)       → latest service_versions row for the slug + its genome + its brief (domain).
 *   invokeService(env, lab, t, in)  → one service call through serviceMessages() and guardOutput() (safety/runtime.ts).
 *
 * runtime "hardened" (default, production): the runtime security block is appended after the genome prompt, user
 * documents are fenced, instruction-like input gets a platform note, and the reply passes guardOutput (prompt-leak
 * block, health dose block, credential / canary / PII masking, invented citation removal).
 * runtime "legacy" (baselines only): how agents ran before the wave — plain genome system prompt, raw input, no output
 * guard. `guard_preview` still reports what the guard WOULD have done, so a red-team campaign can compare both modes.
 *
 * Nothing here touches the eval path (solveMessages / runArm), thresholds, the governor or any promoted genome.
 * Each call spends exactly one LabLLM call (lab.complete), so the lab ledger, the kill switch and the per-agent caps
 * all apply. Services stay owner-only: /api/health reports services_public=false and there is no public route.
 */
import type { Env } from "../env";
import type { LabLLM } from "../eval/llm";
import { parseAnswer } from "../eval/solver";
import type { Genome } from "../genome/schema";
import { Registry } from "../registry/registry";
import { guardOutput, scanInput, serviceMessages, RUNTIME_VERSION, type GuardResult, type ServiceInput } from "../safety/runtime";
import { getDesign, loadBrief } from "./store";
import type { StudioBrief } from "./types";

export type ServiceRuntime = "hardened" | "legacy";
export const SERVICE_RUNTIMES: readonly ServiceRuntime[] = ["hardened", "legacy"];

/** Hard caps on what one call may carry (the /api/* body cap is larger; these bound prompt size). */
export const SERVICE_LIMITS = { request: 8_000, document: 40_000, maxTokens: 1_500 } as const;

export interface ServiceTarget {
  slug: string;
  version: number;
  genome: Genome;
  /** Safety domain of the brief (SafetyProfile.domain), e.g. "health-information". */
  domain?: string;
  brief_id?: string;
  /** The brief's mandatory disclaimer (SafetyProfile.disclaimer_ar / _en); hardened mode appends it when a reply omits it. */
  disclaimer?: { ar?: string; en?: string };
}

export class ServiceError extends Error {
  constructor(
    public code: "not_found" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

/** Latest promoted version of a service (or a specific version). */
export async function resolveService(env: Env, slug: string, version?: number): Promise<ServiceTarget | null> {
  const row = await env.DB.prepare(
    version
      ? "SELECT slug, version, design_id, genome_id FROM service_versions WHERE slug = ?1 AND version = ?2"
      : "SELECT slug, version, design_id, genome_id FROM service_versions WHERE slug = ?1 ORDER BY version DESC LIMIT 1",
  )
    .bind(...(version ? [slug, version] : [slug]))
    .first<{ slug: string; version: number; design_id: string; genome_id: string }>()
    .catch(() => null);
  if (!row) return null;
  const genome = await new Registry(env).getGenome(row.genome_id);
  if (!genome) return null;
  const design = await getDesign(env, row.design_id).catch(() => null);
  const brief: StudioBrief | null = design ? await loadBrief(env, design.brief_id).catch(() => null) : null;
  const sp = brief?.safety;
  const disclaimer = sp && (sp.disclaimer_ar || sp.disclaimer_en) ? { ...(sp.disclaimer_ar ? { ar: sp.disclaimer_ar } : {}), ...(sp.disclaimer_en ? { en: sp.disclaimer_en } : {}) } : undefined;
  return { slug: row.slug, version: row.version, genome, domain: sp?.domain, brief_id: brief?.id, ...(disclaimer ? { disclaimer } : {}) };
}

export interface InvokeOptions {
  runtime?: ServiceRuntime;
  /** Red-team canaries placed in the system message (never in the user's turn); masked on output. */
  confidential?: string[];
  /** Extra values that must never leave (canaries, keys known to the runtime). */
  secrets?: string[];
  agentId?: string;
}

export interface ServiceReply {
  slug: string;
  version: number;
  runtime: ServiceRuntime;
  runtime_version: string | null;
  /** What the person receives (guarded in hardened mode; raw in legacy mode). */
  answer: string;
  /** hardened: the guard that ran. legacy: null. */
  guard: Pick<GuardResult, "actions" | "blocked"> | null;
  /** hardened: the brief's mandatory disclaimer was missing from the model's reply and was appended. */
  disclaimer_appended?: boolean;
  /** legacy only: what guardOutput would have done to this reply. */
  guard_preview?: Pick<GuardResult, "actions" | "blocked">;
  input_flags: string[];
  model: string;
  tokens: number;
}

export function validateServiceInput(input: Partial<ServiceInput> | null | undefined): ServiceInput {
  const request = typeof input?.request === "string" ? input.request.trim() : "";
  if (!request) throw new ServiceError("bad_request", "request (string) is required");
  if (request.length > SERVICE_LIMITS.request) throw new ServiceError("bad_request", `request longer than ${SERVICE_LIMITS.request} characters`);
  const document = typeof input?.document === "string" && input.document.trim() ? input.document : undefined;
  if (document && document.length > SERVICE_LIMITS.document) throw new ServiceError("bad_request", `document longer than ${SERVICE_LIMITS.document} characters`);
  return { request, document };
}

/** One service call (1 LabLLM call). */
export async function invokeService(env: Env, lab: LabLLM, t: ServiceTarget, rawInput: ServiceInput, opts: InvokeOptions = {}): Promise<ServiceReply> {
  const input = validateServiceInput(rawInput);
  const runtime: ServiceRuntime = opts.runtime ?? "hardened";
  if (!SERVICE_RUNTIMES.includes(runtime)) throw new ServiceError("bad_request", `runtime must be one of ${SERVICE_RUNTIMES.join(", ")}`);
  const messages = serviceMessages(t.genome, input, { runtime, domain: t.domain, confidential: opts.confidential });
  const res = await lab.complete(
    opts.agentId ?? `service:${t.slug}`,
    { messages, temperature: t.genome.model_policy.temperature, json: true, maxTokens: SERVICE_LIMITS.maxTokens },
    t.genome.model_policy,
  );
  const raw = parseAnswer(res.text);
  const ctx = {
    systemPrompt: messages[0].content,
    domain: t.domain,
    secrets: [...(opts.confidential ?? []), ...(opts.secrets ?? [])],
    input: `${input.request}\n${input.document ?? ""}`,
  };
  const g = guardOutput(raw, ctx);
  const base = {
    slug: t.slug,
    version: t.version,
    runtime,
    input_flags: scanInput(ctx.input).flags,
    model: res.model,
    tokens: res.tokensIn + res.tokensOut,
  };
  if (runtime === "legacy") return { ...base, runtime_version: null, answer: raw, guard: null, guard_preview: { actions: g.actions, blocked: g.blocked } };
  const d = ensureDisclaimer(g.text, t.disclaimer);
  return { ...base, runtime_version: RUNTIME_VERSION, answer: d.text, guard: { actions: g.actions, blocked: g.blocked }, ...(d.appended ? { disclaimer_appended: true } : {}) };
}

// ---------------------------------------------------------------- mandatory disclaimer (hardened mode)

/** Arabic/Latin fold for presence checks: no diacritics/tatweel, one alef/ya/ta-marbuta/hamza form, no punctuation. */
export function foldText(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئ]/g, "ء")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOP = new Set(["ده", "دي", "دا", "و", "او", "في", "من", "مش", "لا", "ليس", "ليست", "the", "a", "an", "not", "and", "or", "of", "for", "this", "is"]);
/** Content words of a folded text, with a leading و/ال/لل/بال/وال stripped (so «والحالة» ~ «حالة»). */
function contentWords(folded: string): string[] {
  return folded
    .split(" ")
    .map((w) => (/^[\u0600-\u06FF]/.test(w) ? w.replace(/^(وال|بال|لل|فال|كال|ال|و)(?=[\u0600-\u06FF]{3,})/, "") : w))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/**
 * Domain-agnostic "says it is not advice" cues. A reply that already carries one of these phrasings of its disclaimer
 * must not get a second copy (models paraphrase: «مش استشارة قانونية», «لا يغني عن الطبيب», "not medical advice").
 */
const NEGATED_ADVICE = [
  /(مش|ليس|ليست|لا تعتبر|لا يعتبر|لا تعد|لا يعد|لا تغني عن|لا يغني عن|ولا تغني عن|ليست بديلا عن|ليس بديلا عن|مش بديل عن)( [^ ]+){0,3} (استشاره|تشخيص|نصيحه)/,
  /(لا تغني|لا يغني|مش بتغني|مش بيغني|ليست بديلا|ليس بديلا|مش بديل)( [^ ]+){0,3} (عن )?(ال)?(طبيب|دكتور|محامي|محام|مختص|استشاره)/,
  /\bnot (a |an )?(substitute for |replacement for )?(professional |medical |legal )?(diagnosis|advice|consultation)\b/,
];

/** True when `reply` already carries `disclaimer` (exact, folded, a paraphrase sharing most of its words, or a negated-advice cue). */
export function hasDisclaimer(reply: string, disclaimer: string): boolean {
  const r = foldText(reply);
  const d = foldText(disclaimer);
  if (!d) return true;
  if (r.includes(d)) return true;
  if (NEGATED_ADVICE.some((re) => re.test(r))) return true;
  const want = [...new Set(contentWords(d))];
  if (!want.length) return false;
  const have = new Set(contentWords(r));
  const hit = want.filter((w) => have.has(w) || [...have].some((h) => h.length >= 4 && (h.startsWith(w) || w.startsWith(h)))).length;
  return hit / want.length >= 0.6;
}

/** Append the brief's mandatory disclaimer when the reply omits it (Arabic unless the reply has no Arabic and an English one exists). */
export function ensureDisclaimer(reply: string, disclaimer?: { ar?: string; en?: string }): { text: string; appended: boolean } {
  const text = String(reply ?? "");
  if (!disclaimer || !(disclaimer.ar || disclaimer.en)) return { text, appended: false };
  const all = [disclaimer.ar, disclaimer.en].filter((x): x is string => !!x);
  if (all.some((d) => hasDisclaimer(text, d))) return { text, appended: false };
  const arabic = /[\u0600-\u06FF]/.test(text) || !text.trim();
  const pick = (arabic ? disclaimer.ar ?? disclaimer.en : disclaimer.en ?? disclaimer.ar)!;
  return { text: text.trim() ? `${text.trimEnd()}\n\n${pick}` : pick, appended: true };
}
