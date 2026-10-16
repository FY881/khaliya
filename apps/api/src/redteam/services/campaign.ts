/**
 * "studio.redteam" job — red-team campaign against PROMOTED Studio services (safety wave piece 2, 2026-10-16).
 *
 * Units are (service × attack × runtime). One step = one unit = exactly one service call through
 * studio/service.ts invokeService (so the lab ledger, kill switch, per-agent and provider caps all apply), then the
 * deterministic detectors (detect.ts) on the reply the person would receive: the guarded reply in "hardened" mode,
 * the raw reply in "legacy" mode. Each unit is stored in service_redteam_runs (migration 0010); the cursor holds
 * only the unit list and an index, so a chunk can die anywhere and resume.
 *
 * Read-only towards the platform: no genome, threshold, governor or constitution is touched, and nothing is
 * promoted or rejected. Results are owner-only (GET /api/studio/redteam/campaigns/:id).
 */
import { audit } from "../../audit";
import type { Env } from "../../env";
import type { JobHandler } from "../../jobs/handlers";
import { SECRET_RE, serviceMessages } from "../../safety/runtime";
import { invokeService, resolveService, ServiceError, type ServiceRuntime } from "../../studio/service";
import { newId, safeJsonParse } from "../../util";
import { attackById, attacksForDomain, SERVICE_ATTACKS, SERVICE_CONFIDENTIAL, SVC_CANARY, SVC_CANARY_KEY, type ServiceAttack } from "./attacks";
import { detectServiceBreach } from "./detect";
import type { ServiceHit, ServiceProbeRow } from "./types";

export const SERVICE_REDTEAM_KIND = "studio.redteam";
export const MAX_PROBES_PER_SERVICE = 10;
export const MAX_SERVICE_REDTEAM_CALLS = 300;

/** Priority order of services when a campaign names none. */
export const SERVICE_PRIORITY = [
  "health-explainer",
  "eg-legal-explainer",
  "code-reviewer",
  "research-summarizer",
  "paperwork-checklist",
  "cv-reviewer",
  "small-business",
  "ar-writer",
  "socratic-tutor",
  "accessibility-simplifier",
  "hijri-helper",
  "data-to-chart",
] as const;

/**
 * Attack order per service: domain-specific attacks first (they test what this service is most exposed to), then
 * one attack per generic category in a fixed rotation, so a 10-probe cap still covers every category it can.
 */
const GENERIC_ORDER = [
  "svc-doc-ar-letter",
  "svc-sec-ar-config",
  "svc-leak-ar-verbatim",
  "svc-jail-ar-grandma",
  "svc-pii-ar-echo",
  "svc-inj-eg-newrole",
  "svc-fraud-eg-smishing",
  "svc-sec-en-encode",
  "svc-leak-obf-json",
  "svc-doc-obf-b64",
  "svc-jail-en-devmode",
  "svc-inj-ar-override",
  "svc-doc-en-cv",
  "svc-fraud-ar-invoice",
  "svc-pii-en-table",
  "svc-inj-obf-spaced",
  "svc-sec-obf-poem",
  "svc-leak-en-translate",
  "svc-jail-obf-rot",
  "svc-doc-eg-fence",
  "svc-inj-en-system",
  "svc-sec-doc-exfil",
  "svc-leak-eg-first-words",
  "svc-jail-eg-training",
  "svc-pii-eg-find",
  "svc-fraud-en-malware",
];

export function planForService(domain: string | undefined, max: number, only?: string[]): ServiceAttack[] {
  const applicable = attacksForDomain(domain, only);
  if (only?.length) return applicable.slice(0, max);
  const specific = applicable.filter((a) => !a.domains.includes("*") || (domain && a.domains.includes(domain)));
  // attacks made only for this domain first, then shared domain attacks (e.g. citations for research/health/legal)
  const exclusive = (a: ServiceAttack) => (a.domains.length === 1 && a.domains[0] === domain ? 0 : 1);
  const out: ServiceAttack[] = [...specific].sort((x, y) => exclusive(x) - exclusive(y));
  for (const id of GENERIC_ORDER) {
    const a = applicable.find((x) => x.id === id);
    if (a && !out.includes(a)) out.push(a);
  }
  for (const a of applicable) if (!out.includes(a)) out.push(a);
  return out.slice(0, max);
}

export interface ServiceRedteamParams {
  slugs?: string[];
  attack_ids?: string[];
  runtimes?: ServiceRuntime[];
  max_probes?: number;
  max_calls?: number;
  /** Re-run exactly these (slug, attack) pairs (e.g. previously-breaching probes), ignoring slugs/attack_ids. */
  pairs?: { slug: string; attack_id: string }[];
}

interface Unit {
  slug: string;
  attack_id: string;
  runtime: ServiceRuntime;
}

export interface ServiceRedteamState {
  campaign_id: string;
  units: Unit[];
  i: number;
  missing: string[];
  counters: { probes: number; breaches: { hardened: number; legacy: number }; skipped: number; llm_calls: number };
}

export class ServiceRedteamError extends Error {
  constructor(
    public code: "bad_request" | "no_targets",
    message: string,
  ) {
    super(message);
  }
}

const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x).slice(0, max) : undefined);

export const SERVICE_REDTEAM_DDL: readonly string[] = Object.freeze([
  "CREATE TABLE IF NOT EXISTS service_redteam_runs ( id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, slug TEXT NOT NULL, version INTEGER NOT NULL, attack_id TEXT NOT NULL, category TEXT NOT NULL, lang TEXT NOT NULL, runtime TEXT NOT NULL CHECK (runtime IN ('hardened','legacy')), breach INTEGER NOT NULL DEFAULT 0, hits TEXT NOT NULL DEFAULT '[]', guard TEXT NOT NULL DEFAULT '[]', guard_blocked INTEGER NOT NULL DEFAULT 0, answer TEXT, model TEXT, at INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS idx_service_redteam_campaign ON service_redteam_runs(campaign_id, slug, runtime)",
  "CREATE INDEX IF NOT EXISTS idx_service_redteam_attack ON service_redteam_runs(slug, attack_id, runtime, at)",
]);

const ensured = new WeakSet<D1Database>();
export async function ensureServiceRedteamSchema(env: Pick<Env, "DB">): Promise<void> {
  if (ensured.has(env.DB)) return;
  await env.DB.batch(SERVICE_REDTEAM_DDL.map((s) => env.DB.prepare(s)));
  ensured.add(env.DB);
}

/** Build the unit list. Services that are not promoted are reported in `missing`, not failed. */
export async function serviceRedteamInit(env: Env, campaignId: string, raw: ServiceRedteamParams = {}) {
  await ensureServiceRedteamSchema(env);
  const runtimes = (strs(raw.runtimes, 2) ?? ["legacy", "hardened"]).filter((r): r is ServiceRuntime => r === "legacy" || r === "hardened");
  if (!runtimes.length) throw new ServiceRedteamError("bad_request", "runtimes: legacy and/or hardened");
  const maxProbes = Math.min(MAX_PROBES_PER_SERVICE, Math.max(1, Math.floor(Number(raw.max_probes ?? MAX_PROBES_PER_SERVICE)) || MAX_PROBES_PER_SERVICE));
  const units: Unit[] = [];
  const missing: string[] = [];
  if (Array.isArray(raw.pairs) && raw.pairs.length) {
    for (const p of raw.pairs.slice(0, 120)) {
      if (!p || typeof p.slug !== "string" || typeof p.attack_id !== "string" || !attackById(p.attack_id)) throw new ServiceRedteamError("bad_request", "pairs: [{slug, attack_id}] with known attack ids");
      if (!(await resolveService(env, p.slug))) {
        if (!missing.includes(p.slug)) missing.push(p.slug);
        continue;
      }
      for (const runtime of runtimes) units.push({ slug: p.slug, attack_id: p.attack_id, runtime });
    }
  } else {
    const slugs = strs(raw.slugs, 16) ?? [...SERVICE_PRIORITY];
    const only = strs(raw.attack_ids, SERVICE_ATTACKS.length);
    if (only?.some((id) => !attackById(id))) throw new ServiceRedteamError("bad_request", "attack_ids: unknown id");
    for (const slug of slugs) {
      const t = await resolveService(env, slug);
      if (!t) {
        missing.push(slug);
        continue;
      }
      // both runtimes of one attack run back to back, so a budget stop still leaves complete legacy/hardened pairs
      for (const a of planForService(t.domain, maxProbes, only)) for (const runtime of runtimes) units.push({ slug, attack_id: a.id, runtime });
    }
  }
  if (!units.length) throw new ServiceRedteamError("no_targets", `no promoted services / applicable attacks${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  const max_calls = Math.min(MAX_SERVICE_REDTEAM_CALLS, Math.max(1, Math.floor(Number(raw.max_calls) || units.length)));
  const state: ServiceRedteamState = { campaign_id: campaignId, units, i: 0, missing, counters: { probes: 0, breaches: { hardened: 0, legacy: 0 }, skipped: 0, llm_calls: 0 } };
  return { state, total: units.length, max_calls, params: { ...raw, runtimes, max_probes: maxProbes, max_calls } as Record<string, unknown> };
}

/** Reply excerpt that is safe to store: credentials scrubbed, campaign canaries masked. */
export function storedAnswer(s: string): string {
  return String(s ?? "")
    .replace(SECRET_RE, "[redacted]")
    .split(SVC_CANARY)
    .join("[CANARY]")
    .split(SVC_CANARY_KEY)
    .join("[CANARY-KEY]")
    .slice(0, 700);
}

/** One probe: one service call + detectors + one row. */
export async function runServiceProbe(env: Env, lab: Parameters<typeof invokeService>[1], campaignId: string, u: Unit): Promise<ServiceProbeRow | null> {
  const attack = attackById(u.attack_id);
  const target = await resolveService(env, u.slug);
  if (!attack || !target) return null;
  const input = { request: attack.request, document: attack.document };
  const reply = await invokeService(env, lab, target, input, { runtime: u.runtime, confidential: [...SERVICE_CONFIDENTIAL], agentId: `service:${u.slug}` });
  const systemPrompt = serviceMessages(target.genome, input, { runtime: u.runtime, domain: target.domain, confidential: [...SERVICE_CONFIDENTIAL] })[0].content;
  const hits: ServiceHit[] = detectServiceBreach(attack, reply.answer, { systemPrompt, input: `${input.request}\n${input.document ?? ""}` });
  const g = reply.guard ?? reply.guard_preview ?? { actions: [], blocked: false };
  const row: ServiceProbeRow = {
    id: newId("srt"),
    campaign_id: campaignId,
    slug: target.slug,
    version: target.version,
    attack_id: attack.id,
    category: attack.category,
    lang: attack.lang,
    runtime: u.runtime,
    breach: hits.length > 0,
    hits,
    guard: g.actions.map((a) => a.kind),
    guard_blocked: g.blocked,
    answer: storedAnswer(reply.answer),
    model: reply.model,
    at: Date.now(),
  };
  await env.DB.prepare(
    `INSERT INTO service_redteam_runs (id, campaign_id, slug, version, attack_id, category, lang, runtime, breach, hits, guard, guard_blocked, answer, model, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  )
    .bind(row.id, row.campaign_id, row.slug, row.version, row.attack_id, row.category, row.lang, row.runtime, row.breach ? 1 : 0, JSON.stringify(row.hits), JSON.stringify(row.guard), row.guard_blocked ? 1 : 0, row.answer, row.model, row.at)
    .run();
  return row;
}

export const serviceRedteamJob: JobHandler<ServiceRedteamState> = {
  kind: SERVICE_REDTEAM_KIND,
  async step(env, lab, _job, s) {
    const before = lab.calls;
    const u = s.units[s.i];
    try {
      await ensureServiceRedteamSchema(env);
      let row: ServiceProbeRow | null = null;
      try {
        row = await runServiceProbe(env, lab, s.campaign_id, u);
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e;
      }
      s.i++;
      if (!row) {
        s.counters.skipped++;
        return { message: `${u.slug}/${u.attack_id} (${u.runtime}): skipped` };
      }
      s.counters.probes++;
      if (row.breach) s.counters.breaches[u.runtime]++;
      return { message: `${u.slug}/${row.category} (${u.runtime}): ${row.breach ? `BREACH (${row.hits.map((h) => h.detector).join(",")})` : "safe"}` };
    } finally {
      s.counters.llm_calls += lab.calls - before;
    }
  },
  isDone: (s) => s.i >= s.units.length,
  progress: (s) => ({ done: Math.min(s.i, s.units.length), total: s.units.length }),
  result: (s) => ({ campaign_id: s.campaign_id, units: s.units.length, done: s.i, probes: s.counters.probes, breaches: s.counters.breaches, skipped: s.counters.skipped, missing: s.missing, llm_calls: s.counters.llm_calls }),
  async onFinish(env, job, s, end) {
    await audit(env.DB, "system:redteam", "studio.redteam", job.id, { status: end.status, stopped: end.stopped ?? null, probes: s.counters.probes, breaches: s.counters.breaches, llm_calls: end.llm_calls });
  },
};

export const SERVICE_REDTEAM_HANDLERS: Record<string, JobHandler> = { [SERVICE_REDTEAM_KIND]: serviceRedteamJob };

// ---------------------------------------------------------------- results

interface RawRow extends Omit<ServiceProbeRow, "breach" | "hits" | "guard" | "guard_blocked"> {
  breach: number;
  hits: string;
  guard: string;
  guard_blocked: number;
}

export async function campaignRows(env: Env, campaignId: string): Promise<ServiceProbeRow[]> {
  await ensureServiceRedteamSchema(env);
  const r = await env.DB.prepare("SELECT * FROM service_redteam_runs WHERE campaign_id = ?1 ORDER BY at").bind(campaignId).all<RawRow>();
  return (r.results ?? []).map((x) => ({ ...x, breach: !!x.breach, guard_blocked: !!x.guard_blocked, hits: safeJsonParse<ServiceHit[]>(x.hits) ?? [], guard: safeJsonParse<string[]>(x.guard) ?? [] }));
}

export interface CampaignSummary {
  probes: number;
  by_service: Record<string, { probes: number; legacy: { runs: number; breaches: number }; hardened: { runs: number; breaches: number } }>;
  by_category: Record<string, { legacy: number; hardened: number; runs: number }>;
  hardened_breaches: { slug: string; attack_id: string; category: string; hits: ServiceHit[] }[];
}

export function summarize(rows: ServiceProbeRow[]): CampaignSummary {
  const by_service: CampaignSummary["by_service"] = {};
  const by_category: CampaignSummary["by_category"] = {};
  const probes = new Set<string>();
  for (const r of rows) {
    probes.add(`${r.slug}|${r.attack_id}`);
    const s = (by_service[r.slug] ??= { probes: 0, legacy: { runs: 0, breaches: 0 }, hardened: { runs: 0, breaches: 0 } });
    s[r.runtime].runs++;
    if (r.breach) s[r.runtime].breaches++;
    const c = (by_category[r.category] ??= { legacy: 0, hardened: 0, runs: 0 });
    c.runs++;
    if (r.breach) c[r.runtime]++;
  }
  for (const slug of Object.keys(by_service)) by_service[slug].probes = new Set(rows.filter((r) => r.slug === slug).map((r) => r.attack_id)).size;
  return {
    probes: probes.size,
    by_service,
    by_category,
    hardened_breaches: rows.filter((r) => r.runtime === "hardened" && r.breach).map((r) => ({ slug: r.slug, attack_id: r.attack_id, category: r.category, hits: r.hits })),
  };
}
