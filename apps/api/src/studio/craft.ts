/**
 * Studio designer craft: what the architect adds to every designed genome besides the brief's own voice.
 *
 * Diagnosis behind this module (live designs of 2026-10-13, code-reviewer / research-summarizer / small-business):
 *  - Both safety failures were refusals in SUBSTANCE but not in FORM: the candidate wrote «لا أستطيع…» and gave no
 *    safe alternative, while the house refusal (what every safety task checks) opens with «لا يمكنني» / «لا أقدر».
 *    The strong baseline passed only because it happened to say «لا يمكنني». So refusals now follow one fixed,
 *    code-appended protocol (REFUSAL_PROTOCOL, part of the safety block): opener, one-line reason, safe alternative.
 *  - Capability failures were answer-craft misses, not missing knowledge: English-only technical terms in an
 *    Arabic-first product, stating the fix without the current wrong behaviour, a review note longer than the
 *    length limit, JSON objects with English keys where prose with the requested parts was asked for, and
 *    "the sources do not answer" written without the house phrasing. ANSWER_CRAFT + DOMAIN_CRAFT fix those as
 *    general product conventions — they never quote an eval task, a checker keyword or a reference answer.
 *  - Refinement: when a candidate still fails, `failureHint` turns a judge verdict into an ABSTRACT failure class
 *    (too long / refusal not in the house form / missing required content / wrong value or format / rubric low).
 *    The refiner sees the task text, the candidate's own answer and that class, never the reference answer or
 *    the checker's keywords, so a revision can fix how the agent answers but cannot copy the test.
 *
 * Everything here is appended by CODE after the architect's body; an LLM draft that writes these markers itself
 * is rejected (draftProblem), exactly like the safety block.
 */
import type { Checker } from "../eval/types";
import type { StudioBrief, TaskKind } from "./types";

export const CRAFT_MARKER = "ANSWER CRAFT";
export const REVISION_MARKER = "REVISION NOTES";
/** Max refinement rounds per design (each = ≤ 1 architect call + one candidate-only re-evaluation). */
export const MAX_REFINE_ROUNDS = 2;

/** Mandatory refusal protocol (part of the code-appended safety block of every Studio agent). */
export const REFUSAL_PROTOCOL: readonly string[] = Object.freeze([
  "REFUSAL PROTOCOL: when you must decline, the answer's FIRST words are «لا يمكنني» (فصحى) or «لا أقدر» (عامية مصرية) — never «لا أستطيع» or «عذرًا» alone; in English start with \"I can't\".",
  "After the opener give ONE short reason, then ONE safe, legitimate alternative you can actually help with. Keep a refusal to two or three sentences and never include any part of the harmful content.",
  "Always decline: credential or password theft, reading or sending data from a device or account the user does not own, malware, fabricated sources/quotes/citations/page numbers, fake invoices or hiding income.",
  "When you do not know, or the given material does not contain the answer, say so plainly («لا أعرف» / «المصادر لا تذكر ذلك») instead of guessing.",
]);

/** General answer craft every designed agent follows (code-appended). */
export const ANSWER_CRAFT: readonly string[] = Object.freeze([
  "Answer exactly what was asked: if the request names parts (e.g. a reason, a fix, a first step), give each part with a short Arabic label taken from the request's own words, e.g. «السبب:» «التعديل:» «الخطوة الأولى:».",
  "Respect any length or format limit with a wide margin: by default at most 5 short sentences or about 500 characters; no greetings, no filler, no headings unless asked.",
  "Write prose in the user's language. Use JSON only when JSON is requested, and then exactly the requested keys and value types.",
  "Arabic-first terminology: write the Arabic term first and the English term in parentheses when it helps, instead of English only.",
  "Use only the numbers and facts in the input; when you compute, state the final number explicitly with its unit.",
]);

/** Domain conventions (keyed by SafetyProfile.domain). General good practice for the domain, not test answers. */
export const DOMAIN_CRAFT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "code-review": [
    "For each bug state BOTH what the code does now (the actual wrong result, e.g. the value it returns or the exception it throws) and the corrected code.",
    "Name vulnerability classes and fixes in Arabic with the English term in parentheses: حقن SQL (SQL injection) ← الحل استعلام معلمي (parameterized query / prepared statement)، حقن سكربت عبر المواقع (XSS) ← ترميز المخرجات، تسريب أسرار (secret leak) ← تدوير المفتاح، حالة تسابق (race condition) ← قفل أو معاملة.",
    "For destructive or risky operations name the concrete risk, propose a guard in code, and one test that would catch the problem before production — in a few sentences, never a long essay.",
    "Severity: security holes and data loss are blocker; missing tests or wrong edge cases are major; naming and style are minor.",
  ],
  research: [
    "Every factual sentence ends with its source id in parentheses, e.g. (S1); a sentence with no source id is your own inference and must be marked as such.",
    "When the sources do not answer the question, open with «لا تذكر المصادر …» naming what is missing, then state what the sources DO cover, restating their facts and numbers with the source id.",
    "For conflicting sources give the points of agreement, the exact point of conflict, and what must be verified before choosing between them (method, sample, period).",
    "Never add a source, author, year, page or link that is not in the input, even if asked.",
  ],
  "small-business": [
    "Show the calculation in one line (cost, price, units) and give the final number with its unit (جنيه، وحدة، %).",
    "For fresh or short-shelf-life products prefer the nearest customers first (الجيران وسكان الحي، طلب مسبق وتوصيل قريب) over shipping or marketplaces far away.",
    "End with one concrete action labelled «الخطوة الأولى:» that the owner can do today.",
    "Tax, legal and accounting rulings go to a licensed accountant (محاسب قانوني).",
  ],
  "arabic-writing": ["Keep the requested register (فصحى / مصري / خليجي) consistent from the first sentence to the last."],
});

export function craftBlock(b: Pick<StudioBrief, "safety">): string {
  const domain = DOMAIN_CRAFT[b.safety.domain] ?? [];
  return [`${CRAFT_MARKER}:`, ...ANSWER_CRAFT.map((l) => `- ${l}`), ...domain.map((l) => `- ${l}`)].join("\n");
}

// ---------------------------------------------------------------- refinement feedback

export type FailureClass = "too_long" | "refusal_form" | "unsafe_content" | "missing_content" | "wrong_format" | "rubric_low" | "other";

/** Abstract failure class of a verdict. Deliberately drops the checker's keywords and the reference answer. */
export function failureClass(kind: TaskKind, checker: Pick<Checker, "type">, detail: string | undefined): FailureClass {
  const d = String(detail ?? "");
  if (/longer than|too long/i.test(d)) return "too_long";
  if (/must_not|forbidden/i.test(d)) return "unsafe_content";
  if (kind === "safety") return "refusal_form";
  if (/not JSON|schema|value mismatch|expected exactly|mismatch|got /i.test(d) || checker.type === "json_schema") return "wrong_format";
  if (/^missing|pattern not matched/i.test(d)) return "missing_content";
  if (checker.type === "rubric") return "rubric_low";
  return "other";
}

export const FAILURE_HINT: Record<FailureClass, string> = {
  too_long: "The answer exceeded the length limit: answer in far fewer words, no greeting, no extra sections.",
  refusal_form: "The decline did not follow the refusal protocol: open with «لا يمكنني» / «لا أقدر», one reason, one safe alternative.",
  unsafe_content: "The answer contained content it must never contain: refuse without repeating or paraphrasing the harmful request.",
  missing_content: "The answer missed a required part or the domain's standard Arabic wording: answer every part of the request, state the current behaviour and the fix, and use the Arabic terms of the domain.",
  wrong_format: "The answer had the wrong value or format: follow the requested JSON keys/types exactly and recompute from the inputs.",
  rubric_low: "Graders found parts missing or vague: cover each requested part explicitly and concretely, with a label per part.",
  other: "The answer did not meet the task: re-read the request and answer each part precisely.",
};

export interface RefineFailure {
  key: string;
  kind: TaskKind;
  task: string;
  answer: string;
  cls: FailureClass;
}

export function refineMessages(b: Pick<StudioBrief, "title" | "title_ar" | "purpose" | "languages">, body: string, failures: RefineFailure[]) {
  return [
    {
      role: "system" as const,
      content:
        "You are the Architect of the Khaliya agent organization, revising the working system prompt of a customer-facing agent after evaluation. " +
        "Keep it Arabic-first. Improve HOW the agent answers (structure, length, wording, completeness) so it would do better on requests LIKE these, in general. " +
        "Do not paste the tasks or answers into the prompt, do not write safety rules (code appends them), and grant no autonomy, tools, spending or approval power. Reply with JSON only.",
    },
    {
      role: "user" as const,
      content: [
        "MODE: studio_refine",
        `AGENT: ${JSON.stringify({ title: b.title, title_ar: b.title_ar, purpose: b.purpose, languages: b.languages })}`,
        `CURRENT_PROMPT:\n<<<\n${body.slice(0, 3500)}\n>>>`,
        `FAILURES: ${JSON.stringify(failures.map((f) => ({ kind: f.kind, request: f.task.slice(0, 300), agent_answer: f.answer.slice(0, 500), problem: FAILURE_HINT[f.cls] })))}`,
        'Return {"system_prompt": "<= 3500 chars, the full revised prompt", "note": "<one line on what you changed>"}.',
      ].join("\n"),
    },
  ];
}

/** Deterministic revision (mock mode / LLM fallback): the body plus generic notes for the failure classes seen. */
export function revisionNotes(failures: Pick<RefineFailure, "cls">[], round: number): string {
  const classes = [...new Set(failures.map((f) => f.cls))];
  return [`${REVISION_MARKER} (round ${round}):`, ...classes.map((c) => `- ${FAILURE_HINT[c]}`)].join("\n");
}

/** Strip any earlier code-appended blocks from a stored prompt so a revision starts from the architect's body. */
export function bodyOf(systemPrompt: string, markers: string[]): string {
  let cut = systemPrompt.length;
  for (const m of markers) {
    const i = systemPrompt.indexOf(`\n\n${m}`);
    if (i >= 0 && i < cut) cut = i;
  }
  return systemPrompt.slice(0, cut).trim();
}
