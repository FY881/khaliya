/**
 * Army kill switches at four levels (master plan §3.6): org, division, mission, agent.
 * Org and agent levels REUSE the existing Governor kill switch read-only (Governor.isKilled) — the army never writes
 * governor_state; the owner keeps flipping those through the existing /api/kill routes. Division and mission
 * switches are army-owned (table army_kill_switches).
 */
import type { Env } from "../env";
import { Governor } from "../governor/governor";
import { armyAudit } from "./audit";
import { DIVISION_IDS, isDivision, type DivisionId } from "./divisions";

export type KillScope = "org" | "division" | "mission" | "agent";

export interface KillQuery {
  agent_id?: string;
  division?: DivisionId | string | null;
  mission_id?: string;
}

export interface KillState {
  killed: boolean;
  scope?: KillScope;
  key?: string;
}

const key = (s: "division" | "mission", id: string) => `${s}:${id}`;

/** First matching switch wins, in order org → division → mission → agent. */
export async function armyKillCheck(env: Env, q: KillQuery = {}): Promise<KillState> {
  const gov = new Governor(env);
  const g = await gov.isKilled(); // global, read-only
  if (g.killed) return { killed: true, scope: "org", key: "kill.global" };
  const keys: string[] = [];
  if (q.division && isDivision(q.division)) keys.push(key("division", q.division));
  if (q.mission_id) keys.push(key("mission", q.mission_id));
  if (keys.length) {
    const rows = (
      await env.DB.prepare(`SELECT scope_key FROM army_kill_switches WHERE on_flag = 1 AND scope_key IN (${keys.map((_, i) => `?${i + 1}`).join(",")})`)
        .bind(...keys)
        .all<{ scope_key: string }>()
    ).results.map((r) => r.scope_key);
    for (const k of keys) if (rows.includes(k)) return { killed: true, scope: k.startsWith("division:") ? "division" : "mission", key: k };
  }
  if (q.agent_id) {
    const a = await gov.isKilled(q.agent_id);
    if (a.killed && a.scope === "agent") return { killed: true, scope: "agent", key: `kill.agent:${q.agent_id}` };
  }
  return { killed: false };
}

export class KillSwitchError extends Error {
  constructor(public code: "bad_scope" | "not_owner", message: string) {
    super(message);
  }
}

/** Owner flips a division or mission switch. Org/agent switches stay with the existing Governor routes. */
export async function setArmyKill(env: Env, scope: "division" | "mission", id: string, on: boolean, actor: string): Promise<void> {
  if (actor !== "owner" && !(actor === "army.guard" && on)) throw new KillSwitchError("not_owner", "only the owner can change army kill switches (the guard may only turn them on)");
  if (scope === "division" && !isDivision(id)) throw new KillSwitchError("bad_scope", `unknown division ${id}`);
  if (scope === "mission" && !/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) throw new KillSwitchError("bad_scope", "bad mission id");
  await env.DB.prepare(
    `INSERT INTO army_kill_switches (scope_key, on_flag, actor, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(scope_key) DO UPDATE SET on_flag = excluded.on_flag, actor = excluded.actor, updated_at = excluded.updated_at`,
  )
    .bind(key(scope, id), on ? 1 : 0, actor, Date.now())
    .run();
  await armyAudit(env.DB, actor, on ? "army.kill.on" : "army.kill.off", key(scope, id));
}

/** Snapshot of every switch the army sees. */
export async function killSnapshot(env: Env) {
  const gov = new Governor(env);
  const rows = (await env.DB.prepare("SELECT scope_key, on_flag, actor, updated_at FROM army_kill_switches WHERE on_flag = 1").all<{ scope_key: string; on_flag: number; actor: string; updated_at: number }>()).results;
  return {
    org: (await gov.isKilled()).killed,
    agents: await gov.killedAgents(),
    divisions: DIVISION_IDS.filter((d) => rows.some((r) => r.scope_key === key("division", d))),
    missions: rows.filter((r) => r.scope_key.startsWith("mission:")).map((r) => r.scope_key.slice("mission:".length)),
  };
}
