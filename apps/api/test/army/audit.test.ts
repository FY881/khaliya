import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { ARMY_GENESIS, armyAudit, listArmyAudit, verifyChain } from "../../src/army/audit";
import { freshState } from "../helpers";

const E = env as Env;
beforeEach(freshState);

async function seed(n: number) {
  for (let i = 0; i < n; i++) await armyAudit(E.DB, "owner", "army.test", `t${i}`, { i });
}

describe("army audit hash chain", () => {
  it("empty chain verifies; entries link prev_hash → hash", async () => {
    expect(await verifyChain(E.DB)).toEqual({ ok: true, checked: 0, head: ARMY_GENESIS });
    await seed(5);
    const rows = (await listArmyAudit(E.DB, 10)).reverse();
    expect(rows[0].prev_hash).toBe(ARMY_GENESIS);
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
    const v = await verifyChain(E.DB);
    expect(v).toMatchObject({ ok: true, checked: 5, head: rows[4].hash });
  });

  it("concurrent appends stay linked", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => armyAudit(E.DB, "system", "army.race", `r${i}`)));
    expect(await verifyChain(E.DB)).toMatchObject({ ok: true, checked: 6 });
  });

  it("detects an edited detail", async () => {
    await seed(4);
    await E.DB.prepare("UPDATE army_audit SET detail = '{\"i\":99}' WHERE seq = 2").run();
    expect(await verifyChain(E.DB)).toMatchObject({ ok: false, broken_at: 2, reason: "content_hash" });
  });

  it("detects a re-hashed edit (content + hash rewritten) through the next link", async () => {
    await seed(4);
    await E.DB.prepare("UPDATE army_audit SET actor = 'attacker', hash = 'f00d' WHERE seq = 2").run();
    const v = await verifyChain(E.DB);
    expect(v.ok).toBe(false);
    expect(v.broken_at).toBe(2);
  });

  it("detects a deleted middle row", async () => {
    await seed(4);
    await E.DB.prepare("DELETE FROM army_audit WHERE seq = 2").run();
    expect(await verifyChain(E.DB)).toMatchObject({ ok: false, broken_at: 3, reason: "prev_link" });
  });

  it("detects a re-pointed prev_hash", async () => {
    await seed(3);
    await E.DB.prepare(`UPDATE army_audit SET prev_hash = '${ARMY_GENESIS}' WHERE seq = 3`).run();
    expect(await verifyChain(E.DB)).toMatchObject({ ok: false, broken_at: 3 });
  });
});
