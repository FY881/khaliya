/**
 * D1 store for org memory: episodic memory per agent (scope 'agent:<id>') and the shared org KB (scope 'org').
 *
 * Write path: validate → scope check → per-agent quota (Governor ledger) → injection scan → trust assignment →
 * exact dedupe (content hash per scope) → near-dup merge (shingle Jaccard vs keyword candidates) → insert +
 * FTS5 row (+ Vectorize upsert when bound).
 * Read path: hybrid retrieval (FTS5 bm25 ⊕ Vectorize cosine, reciprocal-rank fused) re-ranked by trust, decay and
 * use; rejected docs are never returned, untrusted/pending ones are flagged as UNVERIFIED.
 *
 * Trust rules (who can make a doc "trusted"):
 *  - owner / system writes may set trust directly (default trusted);
 *  - an agent's org write lands as 'pending' and becomes trusted only through review (critic role or owner);
 *  - external sources, and any text with injection signals, land as 'untrusted' and only the OWNER can trust them;
 *  - episodic memory (agent scope) is the agent's own unreviewed notes: 'untrusted' (still usable, always flagged).
 */
import { audit } from "../audit";
import { Governor } from "../governor/governor";
import { newId, safeJsonParse } from "../util";
import { deleteVectors, upsertVector, vectorQuery, vectorsEnabled } from "./embed";
import { injectionSignals, isVerified } from "./hygiene";
import { contentHash, foldText, ftsIndexText, ftsQuery, similarity } from "./text";
import { DEFAULT_TTL_DAYS, KbError, MAX_BODY, MAX_TITLE, type KbDoc, type KbHit, type KbKind, type KbTrust, type KbWriteInput, type KbWriteResult, type MemoryEnv } from "./types";

const DAY = 86_400_000;
const KINDS: KbKind[] = ["doc", "episode", "lesson", "summary", "playbook"];

/** Per-agent quotas (owner/system are exempt). Daily counters live in the Governor's `budgets` ledger. */
export const KB_QUOTAS = Object.freeze({
  writes_per_agent_day: 60,
  searches_per_agent_day: 300,
  episodic_max_active: 400,
  pending_max_per_author: 60,
});
export const NEAR_DUP = 0.85;

export const isPrivileged = (author: string) => author === "owner" || author.startsWith("system");
export const agentScope = (agentId: string) => `agent:${agentId}`;

type Raw = Omit<KbDoc, "tags" | "flags" | "summary_of"> & { tags: string; flags: string; summary_of: string | null };
export function toDoc(r: Raw): KbDoc {
  return { ...r, tags: safeJsonParse<string[]>(r.tags) ?? [], flags: safeJsonParse<string[]>(r.flags) ?? [], summary_of: safeJsonParse<string[]>(r.summary_of) };
}

// ------------------------------------------------------------------ quotas
/** Debit one unit of a per-agent KB quota. Throws KbError('quota'). */
export async function debitQuota(env: MemoryEnv, agentId: string, metric: "writes" | "searches"): Promise<void> {
  const cap = metric === "writes" ? KB_QUOTAS.writes_per_agent_day : KB_QUOTAS.searches_per_agent_day;
  if (!(await new Governor(env).debitOne(`kb:agent:${agentId}`, metric, 1, cap))) throw new KbError("quota", `daily KB ${metric} quota (${cap}) used for ${agentId}`);
}

// ------------------------------------------------------------------ write
function authorAgentId(author: string): string | null {
  return author.startsWith("agent:") ? author.slice(6) : null;
}

export async function writeDoc(env: MemoryEnv, input: KbWriteInput): Promise<KbWriteResult> {
  const body = String(input.body ?? "").trim();
  if (!body) throw new KbError("invalid", "body is required");
  if (body.length > MAX_BODY) throw new KbError("invalid", `body longer than ${MAX_BODY} chars`);
  const title = String(input.title ?? "").trim().slice(0, MAX_TITLE) || body.replace(/\s+/g, " ").slice(0, 80);
  const kind: KbKind = input.kind ?? (input.scope && input.scope !== "org" ? "episode" : "doc");
  if (!KINDS.includes(kind)) throw new KbError("invalid", `kind must be one of ${KINDS.join(", ")}`);
  const author = String(input.author ?? "");
  if (!author) throw new KbError("invalid", "author is required");
  const priv = isPrivileged(author);
  const agentId = authorAgentId(author);
  if (!priv && !agentId) throw new KbError("invalid", "author must be owner, system:* or agent:<id>");
  const scope = input.scope ?? "org";
  if (scope !== "org" && !scope.startsWith("agent:")) throw new KbError("invalid", "scope must be 'org' or 'agent:<id>'");
  // An agent may write the org KB and its OWN episodic memory only.
  if (!priv && scope !== "org" && scope !== agentScope(agentId!)) throw new KbError("forbidden", "agents can only write their own memory or the org KB");
  if (!priv && (kind === "playbook" || kind === "lesson") && scope === "org") throw new KbError("forbidden", "playbooks and lessons are distilled by the system");

  if (!priv) await debitQuota(env, agentId!, "writes");

  const source = String(input.source ?? (priv ? (author === "owner" ? "owner" : "system") : "agent")).slice(0, 300);
  const external = /^(https?:|external)/i.test(source);
  const flags = injectionSignals(`${title}\n${body}`);
  let trust: KbTrust;
  if (priv) trust = input.trust ?? "trusted";
  else if (external || flags.length) trust = "untrusted";
  else trust = scope === "org" ? "pending" : "untrusted";
  if (external && !flags.includes("external")) flags.push("external");

  const hash = await contentHash(title, body);
  const db = env.DB;
  const ex = await db.prepare("SELECT * FROM kb_docs WHERE scope = ?1 AND content_hash = ?2").bind(scope, hash).first<Raw>();
  const now = Date.now();
  if (ex) {
    // Exact duplicate: count the vote; a duplicate of an expired/archived doc revives it (fresh TTL).
    const ttl = input.ttl_days === undefined ? DEFAULT_TTL_DAYS[ex.kind as KbKind] : input.ttl_days;
    const revive = ex.status === "expired" || ex.status === "archived";
    await db.prepare(`UPDATE kb_docs SET votes = votes + 1, updated_at = ?2${revive ? ", status = 'active', expires_at = ?3" : ""} WHERE id = ?1`)
      .bind(ex.id, now, ...(revive ? [ttl ? now + ttl * DAY : null] : []))
      .run();
    if (revive) await indexFts(env, ex.id, ex.scope, ex.title, ex.body);
    return { id: ex.id, status: "duplicate", trust: ex.trust, flags: safeJsonParse<string[]>(ex.flags) ?? [] };
  }

  // Quotas on stored volume (agents only).
  if (!priv) {
    if (scope !== "org") {
      const n = (await db.prepare("SELECT COUNT(*) AS n FROM kb_docs WHERE scope = ?1 AND status = 'active'").bind(scope).first<{ n: number }>())?.n ?? 0;
      if (n >= KB_QUOTAS.episodic_max_active) throw new KbError("quota", `episodic memory full (${n}/${KB_QUOTAS.episodic_max_active}); compaction will free space`);
    } else {
      const n = (await db.prepare("SELECT COUNT(*) AS n FROM kb_docs WHERE author = ?1 AND scope = 'org' AND trust = 'pending' AND status = 'active'").bind(author).first<{ n: number }>())?.n ?? 0;
      if (n >= KB_QUOTAS.pending_max_per_author) throw new KbError("quota", `too many docs awaiting review (${n}/${KB_QUOTAS.pending_max_per_author})`);
    }
  }

  // Near-duplicate: compare with the best keyword candidates in the same scope.
  let dupOf: string | null = null;
  const q = input.skip_near_dup && priv ? null : ftsQuery(`${title} ${body.slice(0, 400)}`, 10);
  if (q) {
    const cands = await ftsCandidates(env, q, [scope], 5).catch(() => []);
    for (const c of cands) {
      if (similarity(`${c.title}\n${c.body}`, `${title}\n${body}`) >= NEAR_DUP) {
        dupOf = c.id;
        break;
      }
    }
  }
  const ttl = input.ttl_days === undefined ? DEFAULT_TTL_DAYS[kind] : input.ttl_days;
  const id = newId(scope === "org" ? "kb" : "mem");
  const status = dupOf ? "merged" : "active";
  if (dupOf) flags.push("near_duplicate");
  await db
    .prepare(
      `INSERT INTO kb_docs (id, scope, kind, title, body, tags, source, author, author_role, author_lineage, trust, flags, confidence, content_hash, dup_of,
         expires_at, summary_of, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)`,
    )
    .bind(
      id,
      scope,
      kind,
      title,
      body,
      JSON.stringify((input.tags ?? []).map(String).slice(0, 12)),
      source,
      author,
      input.author_role ?? null,
      input.author_lineage ?? null,
      trust,
      JSON.stringify(flags),
      Math.min(1, Math.max(0, Number(input.confidence ?? 0.5))),
      hash,
      dupOf,
      ttl ? now + ttl * DAY : null,
      input.summary_of ? JSON.stringify(input.summary_of) : null,
      status,
      now,
    )
    .run();
  if (dupOf) {
    await db.prepare("UPDATE kb_docs SET votes = votes + 1, updated_at = ?2 WHERE id = ?1").bind(dupOf, now).run();
    return { id, status: "merged", trust, flags, dup_of: dupOf };
  }
  await indexFts(env, id, scope, title, body);
  if (vectorsEnabled(env)) {
    const stored = (await db.prepare("SELECT COUNT(*) AS n FROM kb_docs WHERE embedded = 1").first<{ n: number }>())?.n ?? 0;
    if (await upsertVector(env, id, scope, `${title}\n${body}`, { kind, trust }, stored)) await db.prepare("UPDATE kb_docs SET embedded = 1 WHERE id = ?1").bind(id).run();
  }
  if (scope === "org") await audit(db, author, "kb.write", id, { kind, trust, flags, source });
  return { id, status: "created", trust, flags };
}

async function indexFts(env: MemoryEnv, id: string, scope: string, title: string, body: string) {
  await env.DB.prepare("DELETE FROM kb_fts WHERE rowid = (SELECT rowid FROM kb_docs WHERE id = ?1)").bind(id).run();
  await env.DB.prepare("INSERT INTO kb_fts (rowid, doc_id, scope, title, body) SELECT rowid, id, scope, ?2, ?3 FROM kb_docs WHERE id = ?1").bind(id, ftsIndexText(title), ftsIndexText(body)).run();
}

/** Remove docs from both indexes (FTS + Vectorize) and set their status. */
export async function setStatus(env: MemoryEnv, ids: string[], status: "archived" | "expired" | "merged" | "active"): Promise<void> {
  if (!ids.length) return;
  const now = Date.now();
  for (const id of ids) {
    if (status === "active") {
      const d = await getDoc(env, id);
      if (d) {
        await env.DB.prepare("UPDATE kb_docs SET status = 'active', updated_at = ?2 WHERE id = ?1").bind(id, now).run();
        await indexFts(env, id, d.scope, d.title, d.body);
      }
      continue;
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM kb_fts WHERE rowid = (SELECT rowid FROM kb_docs WHERE id = ?1)").bind(id),
      env.DB.prepare("UPDATE kb_docs SET status = ?2, embedded = 0, updated_at = ?3 WHERE id = ?1").bind(id, status, now),
    ]);
  }
  if (status !== "active") await deleteVectors(env, ids);
}

// ------------------------------------------------------------------ read
/** Backfill vectors for active docs written before Vectorize was bound. Bounded per call (≤ 25 docs). */
export async function reindexVectors(env: MemoryEnv, limit = 10): Promise<{ enabled: boolean; embedded: number; failed: number; remaining: number }> {
  const db = env.DB;
  const left = async () => (await db.prepare("SELECT COUNT(*) AS n FROM kb_docs WHERE status = 'active' AND embedded = 0").first<{ n: number }>())?.n ?? 0;
  if (!vectorsEnabled(env)) return { enabled: false, embedded: 0, failed: 0, remaining: await left() };
  const n = Math.min(25, Math.max(1, Math.floor(Number(limit) || 10)));
  const rows = (await db.prepare("SELECT id, scope, title, body, kind, trust FROM kb_docs WHERE status = 'active' AND embedded = 0 ORDER BY updated_at DESC LIMIT ?1").bind(n).all<{ id: string; scope: string; title: string; body: string; kind: string; trust: string }>()).results;
  let stored = (await db.prepare("SELECT COUNT(*) AS n FROM kb_docs WHERE embedded = 1").first<{ n: number }>())?.n ?? 0;
  let embedded = 0, failed = 0;
  for (const r of rows) {
    if (await upsertVector(env, r.id, r.scope, `${r.title}\n${r.body}`, { kind: r.kind, trust: r.trust }, stored)) {
      await db.prepare("UPDATE kb_docs SET embedded = 1 WHERE id = ?1").bind(r.id).run();
      embedded++; stored++;
    } else failed++;
  }
  return { enabled: true, embedded, failed, remaining: await left() };
}

export async function getDoc(env: MemoryEnv, id: string): Promise<KbDoc | null> {
  const r = await env.DB.prepare("SELECT * FROM kb_docs WHERE id = ?1").bind(id).first<Raw>();
  return r ? toDoc(r) : null;
}

export async function listDocs(env: MemoryEnv, f: { scope?: string; trust?: string; kind?: string; status?: string; author?: string; limit?: number; offset?: number } = {}): Promise<KbDoc[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.scope) where.push(`scope = ?${args.push(f.scope)}`);
  if (f.trust) where.push(`trust = ?${args.push(f.trust)}`);
  if (f.kind) where.push(`kind = ?${args.push(f.kind)}`);
  where.push(`status = ?${args.push(f.status ?? "active")}`);
  if (f.author) where.push(`author = ?${args.push(f.author)}`);
  const lim = Math.min(Math.max(1, Math.floor(f.limit ?? 50)), 200);
  const off = Math.max(0, Math.floor(f.offset ?? 0));
  const rows = (await env.DB.prepare(`SELECT * FROM kb_docs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id LIMIT ${lim} OFFSET ${off}`).bind(...args).all<Raw>()).results;
  return rows.map(toDoc);
}

async function ftsCandidates(env: MemoryEnv, match: string, scopes: string[], k: number): Promise<(KbDoc & { rank: number })[]> {
  const ph = scopes.map((_, i) => `?${i + 2}`).join(",");
  const rows = (
    await env.DB.prepare(
      `SELECT d.*, bm25(kb_fts, 0, 0, 2.0, 1.0) AS rank FROM kb_fts JOIN kb_docs d ON d.rowid = kb_fts.rowid
       WHERE kb_fts MATCH ?1 AND kb_fts.scope IN (${ph}) AND d.status = 'active' ORDER BY rank LIMIT ${Math.max(1, Math.min(50, k))}`,
    )
      .bind(match, ...scopes)
      .all<Raw & { rank: number }>()
  ).results;
  return rows.map((r) => ({ ...toDoc(r), rank: r.rank }));
}

/** LIKE fallback for when an FTS query cannot run (should be rare: tokens are quoted). */
async function likeCandidates(env: MemoryEnv, q: string, scopes: string[], k: number): Promise<KbDoc[]> {
  const term = `%${q.trim().slice(0, 60).replace(/[%_]/g, "")}%`;
  const ph = scopes.map((_, i) => `?${i + 3}`).join(",");
  const rows = (
    await env.DB.prepare(`SELECT * FROM kb_docs WHERE (body LIKE ?1 OR title LIKE ?2) AND scope IN (${ph}) AND status = 'active' ORDER BY created_at DESC LIMIT ${k}`)
      .bind(term, term, ...scopes)
      .all<Raw>()
  ).results;
  return rows.map(toDoc);
}

const TRUST_W: Record<KbTrust, number> = { trusted: 1, pending: 0.7, untrusted: 0.5, rejected: 0 };
const HALF_LIFE_DAYS: Record<KbKind, number> = { episode: 14, doc: 90, lesson: 60, summary: 60, playbook: 365 };

/** Recency/use decay in [0.2, 1]: halves every HALF_LIFE_DAYS[kind] since last use (or creation). */
export function decayFactor(d: Pick<KbDoc, "kind" | "created_at" | "last_used_at">, now = Date.now()): number {
  const age = Math.max(0, now - (d.last_used_at ?? d.created_at)) / DAY;
  return Math.max(0.2, Math.pow(0.5, age / (HALF_LIFE_DAYS[d.kind] ?? 60)));
}

export interface SearchOptions {
  /** Scopes to search; default ['org']. An agent searching gets ['org', 'agent:<self>']. */
  scopes?: string[];
  k?: number;
  /** Only trusted docs. Default false (unverified docs are returned but flagged). */
  trustedOnly?: boolean;
  /** Count a "use" on returned docs (default true). */
  touch?: boolean;
}

export async function searchDocs(env: MemoryEnv, q: string, opts: SearchOptions = {}): Promise<{ hits: KbHit[]; mode: "hybrid" | "keyword" | "vector" }> {
  const scopes = opts.scopes?.length ? [...new Set(opts.scopes)] : ["org"];
  const k = Math.min(Math.max(1, Math.floor(opts.k ?? 5)), 20);
  const match = ftsQuery(q);
  let kw: KbDoc[] = [];
  if (match) {
    try {
      kw = await ftsCandidates(env, match, scopes, k * 3);
    } catch {
      kw = await likeCandidates(env, q, scopes, k * 3);
    }
  }
  const vec = await vectorQuery(env, q, scopes, k * 2);
  const rrf = new Map<string, { s: number; via: Set<string> }>();
  const add = (id: string, rank: number, via: string) => {
    const e = rrf.get(id) ?? { s: 0, via: new Set<string>() };
    e.s += 1 / (60 + rank);
    e.via.add(via);
    rrf.set(id, e);
  };
  kw.forEach((d, i) => add(d.id, i, "keyword"));
  vec.forEach((v, i) => add(v.id, i, "vector"));
  const byId = new Map(kw.map((d) => [d.id, d]));
  const missing = [...rrf.keys()].filter((id) => !byId.has(id));
  for (const id of missing) {
    const d = await getDoc(env, id);
    if (d) byId.set(id, d);
  }
  const now = Date.now();
  const hits: KbHit[] = [];
  for (const [id, e] of rrf) {
    const d = byId.get(id);
    if (!d || d.status !== "active" || d.trust === "rejected" || !scopes.includes(d.scope)) continue;
    if (opts.trustedOnly && d.trust !== "trusted") continue;
    const score = e.s * TRUST_W[d.trust] * decayFactor(d, now) * (1 + 0.1 * Math.log1p(d.votes + d.uses));
    hits.push({ ...d, score: Math.round(score * 1e6) / 1e6, via: e.via.size > 1 ? "hybrid" : [...e.via][0], verified: isVerified(d) });
  }
  hits.sort((a, b) => b.score - a.score || b.created_at - a.created_at);
  const top = hits.slice(0, k);
  if (opts.touch !== false && top.length) {
    const ph = top.map((_, i) => `?${i + 2}`).join(",");
    await env.DB.prepare(`UPDATE kb_docs SET uses = uses + 1, last_used_at = ?1 WHERE id IN (${ph})`).bind(now, ...top.map((h) => h.id)).run();
  }
  return { hits: top, mode: vec.length && kw.length ? "hybrid" : vec.length ? "vector" : "keyword" };
}

// ------------------------------------------------------------------ review
export interface ReviewInput {
  verdict: "approve" | "reject" | "untrusted";
  reviewer: string; // 'owner' | 'agent:<id>' | 'system:critic'
  reviewer_role?: string | null;
  reviewer_lineage?: string | null;
  method: "owner" | "critic_llm" | "critic_rules";
  notes?: string;
}

/**
 * Apply a review verdict. Separation of powers: nobody reviews their own doc, a reviewer from the author's lineage
 * cannot approve it, and docs flagged as injection-suspect or external can only be trusted by the owner.
 */
export async function reviewDoc(env: MemoryEnv, id: string, r: ReviewInput): Promise<KbDoc> {
  const d = await getDoc(env, id);
  if (!d) throw new KbError("not_found", "doc not found");
  if (r.reviewer !== "owner") {
    if (r.reviewer === d.author) throw new KbError("forbidden", "authors cannot review their own docs");
    if (r.reviewer_lineage && d.author_lineage && r.reviewer_lineage === d.author_lineage) throw new KbError("forbidden", "a reviewer from the author's lineage cannot review this doc");
    if (r.verdict === "approve" && d.flags.some((f) => f !== "near_duplicate")) throw new KbError("forbidden", `flagged doc (${d.flags.join(", ")}) can only be trusted by the owner`);
  }
  const trust: KbTrust = r.verdict === "approve" ? "trusted" : r.verdict === "reject" ? "rejected" : "untrusted";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE kb_docs SET trust = ?2, updated_at = ?3 WHERE id = ?1").bind(id, trust, now),
    env.DB.prepare("INSERT INTO kb_reviews (doc_id, reviewer, reviewer_role, verdict, method, notes, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(
      id,
      r.reviewer,
      r.reviewer_role ?? null,
      r.verdict,
      r.method,
      (r.notes ?? "").slice(0, 1000),
      now,
    ),
  ]);
  if (trust === "rejected") {
    await env.DB.prepare("DELETE FROM kb_fts WHERE rowid = (SELECT rowid FROM kb_docs WHERE id = ?1)").bind(id).run();
    await deleteVectors(env, [id]);
  }
  await audit(env.DB, r.reviewer, "kb.review", id, { verdict: r.verdict, method: r.method, trust });
  return (await getDoc(env, id))!;
}

export async function reviewsFor(env: MemoryEnv, id: string) {
  return (await env.DB.prepare("SELECT * FROM kb_reviews WHERE doc_id = ?1 ORDER BY at, id").bind(id).all()).results;
}

export async function kbStats(env: MemoryEnv) {
  const rows = (await env.DB.prepare("SELECT scope = 'org' AS org, trust, status, COUNT(*) AS n FROM kb_docs GROUP BY 1, 2, 3").all<{ org: number; trust: string; status: string; n: number }>()).results;
  const out = { org: {} as Record<string, number>, episodic: {} as Record<string, number>, by_status: {} as Record<string, number>, vectors: vectorsEnabled(env) };
  for (const r of rows) {
    out.by_status[r.status] = (out.by_status[r.status] ?? 0) + r.n;
    if (r.status !== "active") continue;
    const t = r.org ? out.org : out.episodic;
    t[r.trust] = (t[r.trust] ?? 0) + r.n;
  }
  return out;
}

// ------------------------------------------------------------------ state
export async function getState<T>(env: MemoryEnv, key: string): Promise<T | null> {
  const r = await env.DB.prepare("SELECT value FROM kb_state WHERE key = ?1").bind(key).first<{ value: string }>();
  return safeJsonParse<T>(r?.value);
}
export async function setState(env: MemoryEnv, key: string, value: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO kb_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}
