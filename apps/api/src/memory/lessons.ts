/**
 * Lessons-learned distillation: evolution results (`evolution_notes`, written by the engine at every terminal
 * outcome) → one trusted KB note per (role, operator) that says WHY proposals failed or passed, with counts.
 *
 * Deterministic, no LLM: notes look like "<operator>: <note> — <outcome>: <stage>: reason a | reason b". Reasons are
 * normalised (numbers → #) and counted so recurring failure causes rise to the top. The note is rewritten when new
 * evidence arrives (old version archived), so operators always read one current note per (role, operator).
 *
 * Proposal operators read them through `lessonsFor(env, role, operator?)`.
 */
import type { Env } from "../env";
import { getDoc, getState, setState, setStatus, writeDoc } from "./store";
import type { MemoryEnv } from "./types";

const FAIL = new Set(["rejected", "lost", "rolled_back"]);
const PASS = new Set(["promoted", "canary"]);
const CURSOR_KEY = "distill.cursor";
const lessonKey = (role: string, op: string) => `lesson:${role}:${op}`;

export interface LessonAgg {
  role: string;
  operator: string;
  counts: Record<string, number>;
  fail: Record<string, number>;
  pass: Record<string, number>;
  deltas: number[];
  doc_id: string | null;
  last_at: number;
}

interface NoteRow {
  id: number;
  role: string;
  operator: string;
  outcome: string;
  note: string;
  delta: number | null;
  at: number;
}

/** "<op>: <note> — rejected: static: a | b" → { stage: "static", reasons: ["a", "b"] }. */
export function parseNoteReasons(note: string, outcome: string): { stage: string; reasons: string[] } {
  const i = note.lastIndexOf(" — ");
  let tail = i >= 0 ? note.slice(i + 3) : note;
  if (tail.startsWith(`${outcome}:`)) tail = tail.slice(outcome.length + 1).trim();
  const m = tail.match(/^([a-z_]+):\s*(.*)$/i);
  const stage = m && !/\s/.test(m[1]) ? m[1].toLowerCase() : outcome;
  const rest = m ? m[2] : tail;
  const reasons = rest
    .split(/\s*\|\s*/)
    .map((r) => r.replace(/-?\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim().slice(0, 140))
    .filter((r) => r.length > 2);
  return { stage, reasons: reasons.length ? reasons : [stage] };
}

const top = (o: Record<string, number>, n: number) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);

export function renderLesson(a: LessonAgg): { title: string; body: string } {
  const c = a.counts;
  const total = Object.values(c).reduce((s, x) => s + x, 0);
  const passed = (c.promoted ?? 0) + (c.canary ?? 0);
  const avgDelta = a.deltas.length ? Math.round((a.deltas.reduce((s, x) => s + x, 0) / a.deltas.length) * 1000) / 1000 : null;
  const lines = [
    `Operator "${a.operator}" on role "${a.role}": ${total} outcomes, ${passed} passed (${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ")}).`,
    avgDelta !== null ? `Average score delta vs champion: ${avgDelta}.` : "",
    top(a.fail, 5).length ? `Why it failed (most common first): ${top(a.fail, 5).map(([r, n]) => `${r} (×${n})`).join("; ")}.` : "",
    top(a.pass, 3).length ? `What passed: ${top(a.pass, 3).map(([r, n]) => `${r} (×${n})`).join("; ")}.` : "",
    passed === 0 && total >= 3 ? "Advice: this operator has not passed yet for this role; change its approach before retrying, and avoid the failure causes above." : "",
    passed > 0 && passed / total >= 0.5 ? "Advice: this operator works well for this role; keep its successful pattern." : "",
  ].filter(Boolean);
  return { title: `Lessons: ${a.role} / ${a.operator}`, body: lines.join("\n") };
}

/**
 * Distil up to `limit` new evolution notes (cursor in kb_state). Returns how many notes were read and which
 * lesson docs were (re)written. Idempotent: the cursor only moves past notes that were folded in.
 */
export async function distillLessons(env: MemoryEnv, limit = 100): Promise<{ read: number; lessons: string[]; done: boolean }> {
  const cursor = (await getState<number>(env, CURSOR_KEY)) ?? 0;
  const rows = (await env.DB.prepare(`SELECT id, role, operator, outcome, note, delta, at FROM evolution_notes WHERE id > ?1 ORDER BY id LIMIT ${Math.max(1, Math.min(500, limit))}`).bind(cursor).all<NoteRow>()).results;
  if (!rows.length) return { read: 0, lessons: [], done: true };
  const touched = new Map<string, LessonAgg>();
  for (const r of rows) {
    const key = lessonKey(r.role, r.operator);
    let a = touched.get(key) ?? (await getState<LessonAgg>(env, key));
    if (!a) a = { role: r.role, operator: r.operator, counts: {}, fail: {}, pass: {}, deltas: [], doc_id: null, last_at: 0 };
    a.counts[r.outcome] = (a.counts[r.outcome] ?? 0) + 1;
    if (FAIL.has(r.outcome) || PASS.has(r.outcome)) {
      const { stage, reasons } = parseNoteReasons(r.note, r.outcome);
      const bucket = FAIL.has(r.outcome) ? a.fail : a.pass;
      for (const reason of reasons) {
        const k = `${stage}: ${reason}`;
        bucket[k] = (bucket[k] ?? 0) + 1;
      }
    }
    if (typeof r.delta === "number" && Number.isFinite(r.delta)) a.deltas = [...a.deltas, r.delta].slice(-50);
    a.last_at = Math.max(a.last_at, r.at);
    // keep the reason tables bounded
    for (const b of [a.fail, a.pass]) if (Object.keys(b).length > 40) for (const [k] of top(b, 999).slice(30)) delete b[k];
    touched.set(key, a);
  }
  const lessons: string[] = [];
  for (const [key, a] of touched) {
    const { title, body } = renderLesson(a);
    const old = a.doc_id ? await getDoc(env, a.doc_id) : null;
    const w = await writeDoc(env, { scope: "org", kind: "lesson", title, body, tags: ["lesson", a.role, a.operator], source: "distill:evolution_notes", author: "system:librarian", author_role: "librarian", trust: "trusted", confidence: 0.8, ttl_days: 120, skip_near_dup: true });
    if (old && old.id !== w.id && old.status === "active") await setStatus(env, [old.id], "archived");
    a.doc_id = w.id;
    await setState(env, key, a);
    lessons.push(w.id);
  }
  await setState(env, CURSOR_KEY, rows[rows.length - 1].id);
  return { read: rows.length, lessons, done: rows.length < limit };
}

/**
 * Current lesson lines for a role (optionally one operator), newest evidence first, for the proposal operators.
 * Plain sentences (system-distilled from measured gate results, trusted), each ≤ 400 chars.
 */
export async function lessonsFor(env: Env, role: string, operator?: string, k = 3): Promise<string[]> {
  const where = operator ? "AND title = ?1" : "AND title LIKE ?1";
  const rows = (
    await env.DB.prepare(`SELECT body FROM kb_docs WHERE scope = 'org' AND kind = 'lesson' AND status = 'active' AND trust = 'trusted' ${where} ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(10, k))}`)
      .bind(operator ? `Lessons: ${role} / ${operator}` : `Lessons: ${role} / %`)
      .all<{ body: string }>()
  ).results;
  return rows.map((r) => r.body.replace(/\n/g, " ").slice(0, 400));
}
