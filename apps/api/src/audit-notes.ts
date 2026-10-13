/**
 * Operator notes: facts about manual interventions on the LIVE database that belong in the append-only audit log
 * but happened outside the API. Each note is written once, through audit() (so the hash chain stays valid), and
 * only on a database where its evidence exists (e.g. the corrected ledger row), so dev/test databases never get it.
 * Called from the cron health tick; idempotent.
 */
import { audit } from "./audit";
import type { Env } from "./env";

export interface OperatorNote {
  action: string;
  target: string;
  /** SQL that returns a row only on the database the note is about. */
  evidence: { sql: string; args: unknown[] };
  detail: Record<string, unknown>;
}

export const OPERATOR_NOTES: OperatorNote[] = [
  {
    action: "governor.correction",
    target: "budgets:2026-10-12:lab:llm_calls",
    evidence: { sql: "SELECT 1 AS x FROM budgets WHERE day = ?1 AND scope = ?2 AND metric = ?3", args: ["2026-10-12", "lab", "llm_calls"] },
    detail: {
      day: "2026-10-12",
      scope: "lab",
      metric: "llm_calls",
      from: 678,
      to: 302,
      summary: "Manual correction of the 2026-10-12 lab ledger (678 -> 302): D1 cache hits had been counted as LLM calls (cache-hit bug, fixed in LabLLM.complete the same day).",
      summary_ar: "تصحيح يدوي لعداد المختبر ليوم 2026-10-12 (678 إلى 302): كانت إصابات الكاش تُحتسب استدعاءات (خلل أُصلح في اليوم نفسه).",
      applied: "by hand on 2026-10-12 with the owner's approval; recorded afterwards by the Worker",
    },
  },
];

/** Write every note whose evidence exists and that is not in the audit log yet. Returns how many were written. */
export async function recordOperatorNotes(env: Env, notes: OperatorNote[] = OPERATOR_NOTES): Promise<number> {
  let n = 0;
  for (const note of notes) {
    const seen = await env.DB.prepare("SELECT 1 AS x FROM audit WHERE action = ?1 AND target = ?2 LIMIT 1").bind(note.action, note.target).first();
    if (seen) continue;
    const ev = await env.DB.prepare(note.evidence.sql).bind(...note.evidence.args).first();
    if (!ev) continue;
    await audit(env.DB, "operator", note.action, note.target, note.detail);
    n++;
  }
  return n;
}
