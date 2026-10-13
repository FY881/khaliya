import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { listAudit } from "../../src/audit";
import { FAMILY_MAP, STARTER_SUITES, familiesForSuite } from "../../src/eval/families";
import { ensureSuite, insertItem } from "../../src/eval/store";
import type { Split } from "../../src/eval/types";
import { Governor } from "../../src/governor/governor";
import { Registry } from "../../src/registry/registry";
import { seedStarterOrg } from "../../src/registry/seed";
import { championOf } from "../../src/evolution/engine";
import { acquireLock, lockState, releaseLock } from "../../src/evolution/store";
import { autoEvolve, shouldAutoEvolve } from "../../src/index";
import { api, freshState, login } from "../helpers";

const E = env as Env;
const T = 120_000;
beforeEach(freshState);

/** Active code-core items inserted directly (public d1, safety canaries, private d4). */
async function plantItems(nPrivate = 8) {
  const def = STARTER_SUITES.find((s) => s.id === "code-core")!;
  await ensureSuite(E, def);
  const fams = familiesForSuite("code-core");
  let n = 0;
  const add = async (split: Split, d: number, kind: string) => {
    const g = FAMILY_MAP[kind]!.generate(`routes-test:${split}:${n}`, d, n);
    n++;
    await insertItem(
      E,
      { suite_id: "code-core", task: g.task, inputs: g.inputs, checker: g.checker, reference: g.reference, difficulty: d, tags: g.tags, split },
      { role: "builder", author: "system:seed", status: "active" },
    );
  };
  for (let i = 0; i < 3; i++) await add("public", 1, fams[i % fams.length]!.kind);
  for (let i = 0; i < 2; i++) await add("canary", 1, "safety");
  for (let i = 0; i < nPrivate; i++) await add("private", 4, fams[i % fams.length]!.kind);
}

async function setup() {
  await seedStarterOrg(E);
  await plantItems();
  return login();
}

const ROUTES: [string, string][] = [
  ["GET", "/api/evolution/status"],
  ["GET", "/api/evolution/proposals"],
  ["GET", "/api/evolution/proposals/prop_x"],
  ["GET", "/api/evolution/leaderboard"],
  ["GET", "/api/evolution/tournaments"],
  ["GET", "/api/evolution/tournaments/tour_x"],
  ["GET", "/api/evolution/promotions"],
  ["GET", "/api/evolution/operators"],
  ["GET", "/api/evolution/notes"],
  ["POST", "/api/evolution/tick"],
  ["POST", "/api/evolution/generation"],
  ["POST", "/api/evolution/canaries/can_x/evaluate"],
  ["POST", "/api/evolution/rollback"],
  ["POST", "/api/evolution/proposals/prop_x/reject"],
];

describe("evolution API: auth", () => {
  it("every /api/evolution route needs the owner session; mutations need x-khaliya", async () => {
    for (const [m, p] of ROUTES) {
      const r = await SELF.fetch(`https://k.test${p}`, { method: m, headers: { "x-khaliya": "1", "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    const cookie = await login();
    for (const [m, p] of ROUTES.filter(([m]) => m === "POST")) {
      const r = await SELF.fetch(`https://k.test${p}`, { method: m, headers: { cookie, "content-type": "application/json" }, body: "{}" });
      expect(r.status, `${m} ${p} without x-khaliya`).toBe(403);
    }
  });
});

describe("evolution API: status + validation", () => {
  it("status lists deployed roles with champion, no canary, no lock; bad inputs → 400/404", async () => {
    const cookie = await setup();
    const s = await api(cookie, "/api/evolution/status");
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ lock: null, kill_global: false, last_tick: null, auto: false });
    const b = s.json.roles.find((r: any) => r.role === "builder");
    const champ = (await championOf(E, "builder"))!;
    expect(b.champion).toMatchObject({ agent_id: champ.agent.id, genome_id: champ.genome.id, version: champ.genome.version });
    expect(typeof b.champion.rating).toBe("number"); // seeded elo row
    expect(typeof b.champion.rd).toBe("number");
    expect(b.canary).toBeNull();
    expect(typeof b.candidates_count).toBe("number");

    expect((await api(cookie, "/api/evolution/proposals?role=nope")).status).toBe(400);
    expect((await api(cookie, "/api/evolution/proposals?status=nope")).status).toBe(400);
    expect((await api(cookie, "/api/evolution/leaderboard?role=nope")).status).toBe(400);
    expect((await api(cookie, "/api/evolution/proposals/prop_nope")).status).toBe(404);
    expect((await api(cookie, "/api/evolution/tournaments/tour_nope")).status).toBe(404);
    expect((await api(cookie, "/api/evolution/canaries/can_nope/evaluate", { method: "POST", body: {} })).status).toBe(404);
    expect((await api(cookie, "/api/evolution/proposals/prop_nope/reject", { method: "POST", body: {} })).status).toBe(404);
    expect((await api(cookie, "/api/evolution/generation", { method: "POST", body: { role: "nope" } })).status).toBe(400);
    expect((await api(cookie, "/api/evolution/generation", { method: "POST", body: { role: "builder", operator: "nope" } })).status).toBe(400);
    expect((await api(cookie, "/api/evolution/tick", { method: "POST", body: { roles: ["nope"] } })).status).toBe(400);
    expect((await api(cookie, "/api/evolution/tick", { method: "POST", body: { max_proposals: 99 } })).status).toBe(400);
    expect((await api(cookie, "/api/evolution/rollback", { method: "POST", body: { role: "builder" } })).status).toBe(400);
    expect((await api(cookie, "/api/evolution/rollback", { method: "POST", body: { role: "builder", to_genome_id: "g_nope" } })).status).toBe(404);
    const ops = await api(cookie, "/api/evolution/operators");
    expect(ops.json.operators.length).toBeGreaterThan(5);
    expect(ops.json.operators[0]).toMatchObject({ alpha: 1, beta: 1, mean: 0.5, trials: 0 });
  });
});

describe("evolution API: generation → views → canary → rollback", () => {
  it(
    "generation then proposals / detail / leaderboard / tournaments / operators / notes / promotions; canary evaluate; audited owner rollback",
    async () => {
      const cookie = await setup();
      const old = (await championOf(E, "builder"))!;
      const gen = await api(cookie, "/api/evolution/generation", { method: "POST", body: { sync: true, role: "builder", operator: "prompt_rewrite" } });
      expect(gen.status, gen.text).toBe(200);
      expect(gen.json).toMatchObject({ role: "builder", operator: "prompt_rewrite" });
      expect(["canary", "lost"]).toContain(gen.json.outcome);
      const pid = gen.json.proposal_id;
      expect(await lockState(E)).toBeNull(); // owner lock released

      // proposals list (contract fields)
      const list = await api(cookie, "/api/evolution/proposals?role=builder");
      expect(list.status).toBe(200);
      const p = list.json.proposals.find((x: any) => x.id === pid);
      expect(p).toMatchObject({ role: "builder", operator: "prompt_rewrite", parent_genome_id: old.genome.id, genome_id: gen.json.genome_id, stage: gen.json.outcome, status: gen.json.outcome });
      for (const k of ["reasons", "scores", "created_at", "updated_at"]) expect(p).toHaveProperty(k);
      expect(Array.isArray(p.reasons)).toBe(true);
      expect(p.scores.tournament.games).toBeGreaterThan(0);
      expect(p.scores.sandbox.public).toBeTruthy();
      const filtered = await api(cookie, `/api/evolution/proposals?status=${gen.json.outcome}&limit=5`);
      expect(filtered.json.proposals.map((x: any) => x.id)).toContain(pid);
      expect((await api(cookie, "/api/evolution/proposals?status=open")).json.proposals).toEqual([]);

      // proposal detail
      const det = await api(cookie, `/api/evolution/proposals/${pid}`);
      expect(det.status).toBe(200);
      expect(det.json.genome.id).toBe(gen.json.genome_id);
      expect(det.json.parent_genome.id).toBe(old.genome.id);
      expect(typeof det.json.diff).toBe("string");
      expect(det.json.diff).not.toBe("(no change)");
      expect(det.json.tournament.id).toBe(gen.json.tournament_id);
      expect(det.json.matches.length).toBeGreaterThan(0);
      expect(det.json.proposal.static_report.checks.pass).toBe(true);

      // leaderboard
      const lb = await api(cookie, "/api/evolution/leaderboard?role=builder");
      expect(lb.status).toBe(200);
      const ids = lb.json.ratings.map((r: any) => r.genome_id);
      expect(ids).toContain(gen.json.genome_id);
      expect(ids).toContain(old.genome.id);
      const row = lb.json.ratings.find((r: any) => r.genome_id === old.genome.id);
      expect(row).toMatchObject({ role: "builder", agent_id: old.agent.id, status: "champion", version: old.genome.version });
      expect(row.conservative).toBeCloseTo(row.rating - 2 * row.rd, 2);
      for (let i = 1; i < lb.json.ratings.length; i++) expect(lb.json.ratings[i - 1].conservative).toBeGreaterThanOrEqual(lb.json.ratings[i].conservative);

      // tournaments
      const tl = await api(cookie, "/api/evolution/tournaments?role=builder&limit=10");
      expect(tl.json.tournaments).toHaveLength(1);
      expect(tl.json.tournaments[0]).toMatchObject({ id: gen.json.tournament_id, status: "done", match_count: det.json.matches.length });
      const td = await api(cookie, `/api/evolution/tournaments/${gen.json.tournament_id}`);
      expect(td.json.tournament.participants).toHaveLength(2);
      expect(td.json.proposal_id).toBe(pid);
      expect(td.json.matches).toHaveLength(det.json.matches.length);
      expect(typeof td.json.matches[0].detail).toBe("object");

      // status with ratings + canary
      const st = await api(cookie, "/api/evolution/status");
      const b = st.json.roles.find((r: any) => r.role === "builder");
      expect(typeof b.champion.rating).toBe("number");
      if (gen.json.outcome === "canary") {
        expect(b.canary).toMatchObject({ id: gen.json.canary_id, proposal_id: pid, candidate_genome: gen.json.genome_id });
        expect(b.candidates_count).toBeGreaterThanOrEqual(1);
      }

      // operators (per role and global), notes, promotions
      const ops = await api(cookie, "/api/evolution/operators?role=builder");
      const pr = ops.json.operators.find((o: any) => o.id === "prompt_rewrite");
      expect(pr.trials).toBe(1);
      expect(pr.alpha + pr.beta).toBe(3);
      expect(pr.mean).toBeCloseTo(pr.alpha / 3, 2);
      expect((await api(cookie, "/api/evolution/operators")).json.operators.find((o: any) => o.id === "prompt_rewrite").trials).toBe(1);
      const notes = await api(cookie, "/api/evolution/notes?role=builder&limit=10");
      expect(notes.json.notes.length).toBe(1);
      expect(notes.json.notes[0].operator).toBe("prompt_rewrite");
      const promos = await api(cookie, "/api/evolution/promotions?role=builder");
      expect(promos.json.promotions.map((x: any) => x.kind)).toEqual(gen.json.outcome === "canary" ? ["canary_start"] : []);

      if (gen.json.outcome === "canary") {
        const ev = await api(cookie, `/api/evolution/canaries/${gen.json.canary_id}/evaluate`, { method: "POST", body: { samples: 6 } });
        expect(ev.status, ev.text).toBe(200);
        expect(["promoted", "rolled_back", "running"]).toContain(ev.json.status);
        expect(ev.json.canary.id).toBe(gen.json.canary_id);
      }

      // owner rollback to the previous champion genome (if it moved) or to the candidate genome otherwise
      const cur = (await championOf(E, "builder"))!;
      const target = cur.genome.id === old.genome.id ? gen.json.genome_id : old.genome.id;
      const rb = await api(cookie, "/api/evolution/rollback", { method: "POST", body: { role: "builder", to_genome_id: target } });
      expect(rb.status, rb.text).toBe(200);
      expect(rb.json).toMatchObject({ role: "builder", from_genome: cur.genome.id, to_genome: target, changed: true });
      expect((await championOf(E, "builder"))!.genome.id).toBe(target);
      const audits = await listAudit(E.DB, 200);
      const a = audits.find((x) => x.action === "evolution.owner_rollback");
      expect(a?.actor).toBe("owner");
      const promos2 = await api(cookie, "/api/evolution/promotions?role=builder");
      expect(promos2.json.promotions[0]).toMatchObject({ kind: "owner_rollback", to_genome: target, actor: "owner" });
      expect((await api(cookie, "/api/evolution/rollback", { method: "POST", body: { role: "builder", to_genome_id: target } })).json.changed).toBe(false);
      // wrong role for the genome
      expect((await api(cookie, "/api/evolution/rollback", { method: "POST", body: { role: "critic", to_genome_id: target } })).status).toBe(400);
      expect((await api(cookie, `/api/evolution/proposals/${pid}/reject`, { method: "POST", body: {} })).status).toBe(409); // terminal or canary-closed
    },
    T,
  );
});

describe("evolution API: tick, lock, kill switch, reject", () => {
  it(
    "tick → 409 locked while the lock is held, 423 when killed, 200 otherwise (last_tick recorded)",
    async () => {
      const cookie = await setup();
      expect(await acquireLock(E, "someone-else", 60_000)).toBe(true);
      const locked = await api(cookie, "/api/evolution/tick", { method: "POST", body: { roles: ["builder"], max_proposals: 0 } });
      expect(locked.status).toBe(409);
      expect(locked.json.status).toBe("locked");
      expect(locked.json.lock.holder).toBe("someone-else");
      const lockedGen = await api(cookie, "/api/evolution/generation", { method: "POST", body: { role: "builder", operator: "tool_add" } });
      expect(lockedGen.status).toBe(409);
      expect(lockedGen.json.status).toBe("locked");
      expect((await api(cookie, "/api/evolution/status")).json.lock.holder).toBe("someone-else");
      await releaseLock(E, "someone-else");

      await new Governor(E).setKill("global", true);
      const killed = await api(cookie, "/api/evolution/tick", { method: "POST", body: {} });
      expect(killed.status).toBe(423);
      expect(killed.json.status).toBe("killed");
      expect((await api(cookie, "/api/evolution/generation", { method: "POST", body: { role: "builder" } })).status).toBe(423);
      await new Governor(E).setKill("global", false);

      const ok = await api(cookie, "/api/evolution/tick", { method: "POST", body: { sync: true, roles: ["builder"], max_proposals: 0 } });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json.status).toBe("ok");
      expect(ok.json.generations).toEqual([]);
      expect(await lockState(E)).toBeNull();
      const st = await api(cookie, "/api/evolution/status");
      expect(st.json.last_tick).toMatchObject({ status: "ok" });
      expect(typeof st.json.last_tick.at).toBe("number");
      expect((await listAudit(E.DB, 50)).some((a) => a.action === "evolution.tick.manual" && a.actor === "owner")).toBe(true);
    },
    T,
  );

  it(
    "owner reject closes a canary proposal (canary rolled back, candidate retired) and is audited",
    async () => {
      const cookie = await setup();
      const gen = await api(cookie, "/api/evolution/generation", { method: "POST", body: { sync: true, role: "builder", operator: "prompt_rewrite" } });
      expect(gen.status).toBe(200);
      expect(gen.json.outcome).toBe("canary"); // mock brain: a prompt_rewrite beats the seed champion (as in engine.test)
      const rj = await api(cookie, `/api/evolution/proposals/${gen.json.proposal_id}/reject`, { method: "POST", body: { reason: "not convinced" } });
      expect(rj.status, rj.text).toBe(200);
      expect(rj.json.proposal).toMatchObject({ stage: "rejected", status: "rejected" });
      expect(rj.json.proposal.reasons[0]).toBe("owner: not convinced");
      expect(rj.json.canary_closed).toBe(gen.json.canary_id);
      expect((await new Registry(E).getAgent(gen.json.agent_id))!.status).toBe("retired");
      expect((await api(cookie, "/api/evolution/status")).json.roles.find((r: any) => r.role === "builder").canary).toBeNull();
      expect((await listAudit(E.DB, 50)).some((a) => a.action === "evolution.owner_reject" && a.actor === "owner")).toBe(true);
      expect((await api(cookie, `/api/evolution/proposals/${gen.json.proposal_id}/reject`, { method: "POST", body: {} })).status).toBe(409);
    },
    T,
  );
});

describe("evolution cron", () => {
  it("auto tick only when EVOLUTION_AUTO=on, on the top-of-hour run, and not when killed", async () => {
    await seedStarterOrg(E);
    const top = Date.parse("2026-10-12T10:00:00Z");
    const half = Date.parse("2026-10-12T10:30:00Z");
    expect(E.EVOLUTION_AUTO).toBe("off"); // wrangler.toml default
    expect(shouldAutoEvolve(E, top)).toBe(false);
    expect(await autoEvolve(E, top)).toBe("skipped");
    const on = { ...E, EVOLUTION_AUTO: "on" } as Env;
    expect(shouldAutoEvolve(on, top)).toBe(true);
    expect(shouldAutoEvolve(on, half)).toBe(false);
    await new Governor(E).setKill("global", true);
    expect(await autoEvolve(on, top)).toBe("killed");
    await new Governor(E).setKill("global", false);
    expect(await autoEvolve(on, top)).toBe("ran"); // no eval items → stopped no_roles, still a recorded tick
    const t = (await listAudit(E.DB, 50)).find((a) => a.action === "evolution.tick");
    expect(t).toBeTruthy();
    expect(await lockState(E)).toBeNull();
  });
});
