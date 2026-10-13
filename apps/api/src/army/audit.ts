/**
 * Hash-chained audit ledger for army actions (table army_audit, migration 0009). Separate from the org audit log.
 * Each row's hash covers its content AND prev_hash, so editing, deleting or re-ordering any row breaks verifyChain().
 * The append is conditional on the head not having moved (compare-and-append), retried a few times under contention.
 */
import { canonicalJson, sha256Hex, truncate } from "../util";

export const ARMY_GENESIS = "army-genesis";

export interface ArmyAuditRow {
  seq: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
}

export async function armyEntryHash(r: Pick<ArmyAuditRow, "at" | "actor" | "action" | "target" | "detail" | "prev_hash">): Promise<string> {
  return sha256Hex(canonicalJson({ at: r.at, actor: r.actor, action: r.action, target: r.target, detail: r.detail, prev_hash: r.prev_hash }));
}

async function head(db: D1Database): Promise<{ seq: number; hash: string } | null> {
  return db.prepare("SELECT seq, hash FROM army_audit ORDER BY seq DESC LIMIT 1").first<{ seq: number; hash: string }>();
}

/** Append one army audit entry. Returns its hash. */
export async function armyAudit(db: D1Database, actor: string, action: string, target?: string | null, detail?: unknown): Promise<string> {
  const d = detail === undefined || detail === null ? null : truncate(typeof detail === "string" ? detail : JSON.stringify(detail), 4000);
  const t = target ?? null;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, Math.floor(Math.random() * 8 * Math.min(attempt, 6))));
    const h = await head(db);
    const prev = h?.hash ?? ARMY_GENESIS;
    const at = Date.now();
    const hash = await armyEntryHash({ at, actor, action, target: t, detail: d, prev_hash: prev });
    // Insert only if the head is still `prev` (or the table is still empty for genesis).
    const r = await db
      .prepare(
        `INSERT INTO army_audit (at, actor, action, target, detail, prev_hash, hash)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE COALESCE((SELECT hash FROM army_audit ORDER BY seq DESC LIMIT 1), '${ARMY_GENESIS}') = ?6`,
      )
      .bind(at, actor, action, t, d, prev, hash)
      .run();
    if ((r.meta?.changes ?? 0) > 0) return hash;
  }
  throw new Error("army audit: head kept moving; append failed");
}

export async function listArmyAudit(db: D1Database, limit = 100): Promise<ArmyAuditRow[]> {
  const lim = Math.min(Math.max(1, Math.floor(limit)), 500);
  return (await db.prepare("SELECT * FROM army_audit ORDER BY seq DESC LIMIT ?1").bind(lim).all<ArmyAuditRow>()).results;
}

export interface ChainVerdict {
  ok: boolean;
  checked: number;
  head: string;
  broken_at?: number;
  reason?: "prev_link" | "content_hash";
}

/** Walk the whole chain in seq order (paged) and check every link + content hash. */
export async function verifyChain(db: D1Database): Promise<ChainVerdict> {
  let prev = ARMY_GENESIS;
  let checked = 0;
  let after = 0;
  for (;;) {
    const rows = (await db.prepare("SELECT * FROM army_audit WHERE seq > ?1 ORDER BY seq ASC LIMIT 500").bind(after).all<ArmyAuditRow>()).results;
    if (!rows.length) break;
    for (const r of rows) {
      checked++;
      if (r.prev_hash !== prev) return { ok: false, checked, head: prev, broken_at: r.seq, reason: "prev_link" };
      if ((await armyEntryHash(r)) !== r.hash) return { ok: false, checked, head: prev, broken_at: r.seq, reason: "content_hash" };
      prev = r.hash;
      after = r.seq;
    }
  }
  return { ok: true, checked, head: prev };
}
