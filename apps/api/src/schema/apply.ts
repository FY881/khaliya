/**
 * Self-service schema for additive migrations (0004 Tool Forge, 0005 Discovery Lab), for when
 * `wrangler d1 migrations apply --remote` cannot be run (no API token for the account). Each embedded migration is
 * applied atomically in one D1 batch (CREATE ... IF NOT EXISTS only) and recorded in d1_migrations under the same
 * name wrangler uses, so a later `wrangler d1 migrations apply` sees it as done. Owner route + cron safety net.
 */
import { audit } from "../audit";
import type { Env } from "../env";
import { EMBEDDED_MIGRATIONS } from "./migrations.gen";

const D1_MIGRATIONS_DDL = "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)";

export interface MigrationStatus {
  recorded: string[];
  embedded: { name: string; statements: number; applied: boolean }[];
  pending: string[];
}

export async function migrationStatus(env: Env): Promise<MigrationStatus> {
  await env.DB.prepare(D1_MIGRATIONS_DDL).run();
  const recorded = ((await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results ?? []).map((r) => r.name);
  const embedded = EMBEDDED_MIGRATIONS.map((m) => ({ name: m.name, statements: m.statements.length, applied: recorded.includes(m.name) }));
  return { recorded, embedded, pending: embedded.filter((m) => !m.applied).map((m) => m.name) };
}

/** Apply every embedded migration not yet recorded. Returns the names applied now. Idempotent. */
export async function applyEmbeddedMigrations(env: Env, actor = "owner"): Promise<string[]> {
  const st = await migrationStatus(env);
  const done: string[] = [];
  for (const m of EMBEDDED_MIGRATIONS) {
    if (!st.pending.includes(m.name)) continue;
    await env.DB.batch([...m.statements.map((s) => env.DB.prepare(s)), env.DB.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?1)").bind(m.name)]);
    done.push(m.name);
  }
  if (done.length) await audit(env.DB, actor, "schema.migrate", null, { applied: done });
  return done;
}
