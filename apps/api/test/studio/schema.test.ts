/** Parity: the embedded STUDIO_SERVICES_DDL must match migrations/0008_studio_services.sql statement for statement. */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { ensureStudioServicesSchema, STUDIO_SERVICES_DDL, STUDIO_SERVICES_MIGRATION } from "../../src/services/schema";

const E = env as Env & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const norm = (s: string) => s.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").replace(/\(\s+/g, "( ").replace(/\s+\)/g, " )").replace(/\s*;\s*$/, "").trim();

describe("0008 schema parity", () => {
  it("embedded DDL equals the migration file", () => {
    const m = E.TEST_MIGRATIONS.find((x) => x.name === STUDIO_SERVICES_MIGRATION);
    expect(m, "migration 0008 present").toBeTruthy();
    const fromFile = m!.queries.map(norm).filter((q) => /^CREATE/i.test(q));
    expect(fromFile.length).toBe(STUDIO_SERVICES_DDL.length);
    expect(fromFile).toEqual(STUDIO_SERVICES_DDL.map(norm));
    expect(STUDIO_SERVICES_DDL.every((s) => /IF NOT EXISTS/.test(s))).toBe(true);
  });

  it("ensureStudioServicesSchema is idempotent on a migrated DB", async () => {
    await ensureStudioServicesSchema(E);
    await ensureStudioServicesSchema(E);
    const t = await E.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('studio_briefs','studio_designs','service_versions')").all<{ name: string }>();
    expect(t.results.map((r) => r.name).sort()).toEqual(["service_versions", "studio_briefs", "studio_designs"]);
  });
});
