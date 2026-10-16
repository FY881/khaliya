import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listAudit, verifyAuditChain } from "../src/audit";
import { OPERATOR_NOTES, recordOperatorNotes } from "../src/audit-notes";
import type { Env } from "../src/env";
import { healthTick } from "../src/index";
import { api, freshState, login } from "./helpers";

const E = env as unknown as Env;
beforeEach(freshState);

describe("embedded migrations (0004–0010) for remote DBs without wrangler access", () => {
  it("status shows them applied in tests; a DB missing the records gets them applied + recorded, idempotently", async () => {
    const cookie = await login();
    const s = await api(cookie, "/api/admin/migrations");
    expect(s.status).toBe(200);
    expect(s.json.embedded.map((m: any) => m.name)).toEqual(["0004_forge.sql", "0005_discovery.sql", "0006_redteam.sql", "0007_memory_court.sql", "0008_studio_services.sql", "0009_army.sql", "0010_service_redteam.sql"]);
    await E.DB.prepare("DELETE FROM d1_migrations WHERE name IN ('0004_forge.sql','0005_discovery.sql','0006_redteam.sql','0007_memory_court.sql','0008_studio_services.sql','0009_army.sql','0010_service_redteam.sql')").run();
    expect((await api(cookie, "/api/admin/migrations")).json.pending).toEqual(["0004_forge.sql", "0005_discovery.sql", "0006_redteam.sql", "0007_memory_court.sql", "0008_studio_services.sql", "0009_army.sql", "0010_service_redteam.sql"]);
    const a = await api(cookie, "/api/admin/migrations/apply", { method: "POST", body: {} });
    expect(a.json).toMatchObject({ applied: ["0004_forge.sql", "0005_discovery.sql", "0006_redteam.sql", "0007_memory_court.sql", "0008_studio_services.sql", "0009_army.sql", "0010_service_redteam.sql"], pending: [] });
    const b = await api(cookie, "/api/admin/migrations/apply", { method: "POST", body: {} });
    expect(b.json.applied).toEqual([]);
    expect((await listAudit(E.DB, 5)).some((x) => x.action === "schema.migrate")).toBe(true);
  });
});

describe("operator notes (manual interventions on the live DB)", () => {
  it("the 2026-10-12 lab-ledger correction is written once, only where its ledger row exists, with a valid hash chain", async () => {
    expect(await recordOperatorNotes(E)).toBe(0); // no evidence in a fresh DB
    await E.DB.prepare("INSERT INTO budgets (day, scope, metric, used, cap) VALUES ('2026-10-12', 'lab', 'llm_calls', 302, 735)").run();
    await healthTick(E);
    await healthTick(E);
    const notes = (await listAudit(E.DB, 50)).filter((a) => a.action === "governor.correction");
    expect(notes).toHaveLength(1);
    expect(notes[0].target).toBe(OPERATOR_NOTES[0].target);
    expect(JSON.parse(notes[0].detail!)).toMatchObject({ from: 678, to: 302, day: "2026-10-12" });
    expect((await verifyAuditChain(E.DB)).ok).toBe(true);
    const cookie = await login();
    const ev = await api(cookie, "/api/hive/events?since=0&limit=200");
    expect(ev.json.events.find((e: any) => e.kind === "governor_correction")).toMatchObject({ title_en: "Manual ledger correction lab (2026-10-12): 678 -> 302" });
  });
});
