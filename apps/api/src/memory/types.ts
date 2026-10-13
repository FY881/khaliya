import type { Env } from "../env";

export type KbTrust = "trusted" | "pending" | "untrusted" | "rejected";
export type KbKind = "doc" | "episode" | "lesson" | "summary" | "playbook";
export type KbStatus = "active" | "archived" | "expired" | "merged";
export type KbSource = "agent" | "owner" | "system" | "external" | "distill" | "compaction";

/**
 * Optional bindings this module uses beyond src/env.ts (kept local so env.ts is untouched):
 *  KB_VECTORS  Vectorize index (1024 dims, cosine) for @cf/baai/bge-m3 embeddings.
 *  KB_EMBED    "off" disables embeddings even when AI + KB_VECTORS are bound.
 */
export type MemoryEnv = Env & { KB_VECTORS?: Vectorize; KB_EMBED?: string };

export interface KbDoc {
  id: string;
  scope: string; // 'org' | 'agent:<id>'
  kind: KbKind;
  title: string;
  body: string;
  tags: string[];
  source: string;
  author: string;
  author_role: string | null;
  author_lineage: string | null;
  trust: KbTrust;
  flags: string[];
  confidence: number;
  content_hash: string;
  dup_of: string | null;
  votes: number;
  uses: number;
  last_used_at: number | null;
  expires_at: number | null;
  summary_of: string[] | null;
  embedded: number;
  status: KbStatus;
  created_at: number;
  updated_at: number;
}
export type KbDocPublic = KbDoc;

export interface KbHit extends KbDoc {
  score: number;
  /** "vector" | "keyword" | "hybrid" — which retriever(s) found it. */
  via: string;
  verified: boolean;
}

export interface KbWriteInput {
  scope?: string;
  kind?: KbKind;
  title?: string;
  body: string;
  tags?: string[];
  source?: string;
  author: string;
  author_role?: string | null;
  author_lineage?: string | null;
  confidence?: number;
  ttl_days?: number | null;
  /** Owner/system only: write straight in at this trust level. Agents always land in 'pending' (org) / 'untrusted' (external). */
  trust?: KbTrust;
  summary_of?: string[];
  /** System rewrites of a living doc (lessons, summaries) skip the near-duplicate merge. Owner/system only. */
  skip_near_dup?: boolean;
}

export interface KbWriteResult {
  id: string;
  status: "created" | "duplicate" | "merged";
  trust: KbTrust;
  flags: string[];
  dup_of?: string;
}

export class KbError extends Error {
  constructor(
    public code: "quota" | "invalid" | "not_found" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

/** Default lifetimes (days) per kind; null = no expiry. */
export const DEFAULT_TTL_DAYS: Record<KbKind, number | null> = { episode: 30, doc: 180, lesson: 120, summary: 120, playbook: null };
export const MAX_TITLE = 160;
export const MAX_BODY = 8000;
