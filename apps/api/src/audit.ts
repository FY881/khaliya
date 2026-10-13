import { canonicalJson, sha256Hex, truncate } from "./util";

export interface AuditEntry {
  seq: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = "genesis";

async function entryHash(at: number, actor: string, action: string, target: string | null, detail: string | null) {
  return sha256Hex(canonicalJson({ at, actor, action, target, detail }));
}

/**
 * Append to the hash-chained audit log. prev_hash is read inside the same INSERT statement, so
 * the link is atomic even with concurrent writers. The table rejects UPDATE/DELETE via triggers.
 */
export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  target?: string | null,
  detail?: unknown,
): Promise<void> {
  const at = Date.now();
  const d = detail === undefined || detail === null ? null : truncate(typeof detail === "string" ? detail : JSON.stringify(detail), 4000);
  const t = target ?? null;
  const hash = await entryHash(at, actor, action, t, d);
  await db
    .prepare(
      `INSERT INTO audit (at, actor, action, target, detail, prev_hash, hash)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT hash FROM audit ORDER BY seq DESC LIMIT 1), '${GENESIS}'), ?6)`,
    )
    .bind(at, actor, action, t, d, hash)
    .run();
}

export async function listAudit(db: D1Database, limit = 100, before?: number): Promise<AuditEntry[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  const q = before
    ? db.prepare("SELECT * FROM audit WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2").bind(before, lim)
    : db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?1").bind(lim);
  return (await q.all<AuditEntry>()).results;
}

/** Verify every entry's content hash and its link to the previous entry. */
export async function verifyAuditChain(db: D1Database): Promise<{ ok: boolean; checked: number; broken_at?: number }> {
  const rows = (await db.prepare("SELECT * FROM audit ORDER BY seq ASC").all<AuditEntry>()).results;
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, checked: rows.length, broken_at: r.seq };
    if ((await entryHash(r.at, r.actor, r.action, r.target, r.detail)) !== r.hash) return { ok: false, checked: rows.length, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}
