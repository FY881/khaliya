import { describe, it, expect } from "vitest";
import { auditToEvent, EVENT_MAP } from "../src/hive/routes";

describe("hive EVENT_MAP covers P5/P8 audit actions", () => {
  const actions = ["redteam.campaign", "redteam.breach_confirmed", "redteam.breach_rejected", "redteam.regression_added", "redteam.gate", "evolution.redteam_skipped", "memory.compact", "court.probe"];
  it("maps every action", () => {
    for (const a of actions) expect(EVENT_MAP[a], a).toBeTruthy();
  });
  it("confirmed breach is never announced and is critical when high severity", () => {
    const e = auditToEvent({ seq: 1, at: 1, action: "redteam.breach_confirmed", target: "b1", detail: JSON.stringify({ category: "injection", agent: "ag1", severity: "high" }) })!;
    expect(e.kind).toBe("breach_confirmed");
    expect(e.severity).toBe("critical");
    expect(e.announce).toBe(false);
    expect(e.title_ar.length).toBeGreaterThan(0);
  });
  it("court probe with spot-checks is a warning", () => {
    const e = auditToEvent({ seq: 2, at: 2, action: "court.probe", target: "j1", detail: JSON.stringify({ rows: 10, spot_checks: 2, status: "done" }) })!;
    expect(e.severity).toBe("warning");
    expect(e.title_en).toContain("10");
  });
});

import { arLightStem, ftsIndexText, ftsQuery } from "../src/memory/text";
describe("Arabic light stemming for KB keyword search", () => {
  it("strips the article and clitic clusters", () => {
    expect(arLightStem("الموافقه")).toBe("موافقه");
    expect(arLightStem("والوكلاء")).toBe("وكلاء");
    expect(arLightStem("الي")).toBe("الي");
    expect(arLightStem("agents")).toBe("agents");
  });
  it("query and index meet on the stem", () => {
    expect(ftsQuery("الموافقة")).toBe('"الموافقه" OR "موافقه"');
    expect(ftsIndexText("طلب الموافقة")).toBe("طلب الموافقه موافقه");
    expect(ftsIndexText("موافقة صريحة")).toBe("موافقه صريحه");
  });
});
