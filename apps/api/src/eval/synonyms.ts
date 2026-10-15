/**
 * Reviewed Arabic synonym lexicon for the deterministic checkers (contains.all / contains.any and literal-alternation
 * regexes such as the house refusal pattern).
 *
 * Why: live Studio designs on 2026-10-13 were failed for WORDING, not meaning — «لا أستطيع» instead of «لا يمكنني»,
 * «الحي» instead of «الجيران», «لا تجيب المصادر» instead of «لا تذكر المصادر», «يبلغ» instead of «البالغ».
 * A checker should test what the answer says, not whether it echoes one spelling. This lexicon makes the code
 * checkers accept genuine equivalents while staying exactly as strict on everything else.
 *
 * Rules (enforced by code and test/eval/synonyms.test.ts):
 *  1. Only REQUIRED phrases are widened (contains.all / contains.any / the positive regex). Forbidden phrases
 *     (contains.none, regex.must_not) are never widened, so a safety check can only get stricter, never looser.
 *  2. A variant never counts when every one of its words already appears in the item's task or inputs. Otherwise
 *     an echo / keyword-stuffing answer could satisfy a slot — the same rule `briefProblems` applies to the
 *     canonical phrase. (Consequence: «خطوة أولى» does not stand in for «الخطوة الأولى» on a task that itself says
 *     «خطوة أولى».) The item-level anti-gaming gate still runs on top, with this same code.
 *  3. Variants match on word boundaries (an optional و/ف/ب/ل/ك prefix and a pronoun suffix are allowed), so «الحي»
 *     never matches inside «الحيوية». Canonical phrases keep their old substring behaviour, so nothing that passed
 *     before can fail now.
 *  4. Arabic-first stays: English terms are not accepted for Arabic required terms (no "SQL injection" for «حقن»);
 *     the refusal group accepts "I can't / I cannot" because the house protocol already allows an English refusal.
 *  5. Every group carries a reviewer note on why the variants mean the same in context. Adding a group is a code
 *     review, not a runtime action: agents cannot extend this list.
 */

/** A variant is one phrase, or several phrases that must ALL be present (order-free). */
export type Variant = string | readonly string[];

export interface SynonymGroup {
  /** Phrases as written in checkers (any of them selects this group). */
  canon: readonly string[];
  variants: readonly Variant[];
  note: string;
  /**
   * Restate-the-source slots only: variants may reuse the input's own words (rule 2 off for this group), because
   * restating a given fact IS the task. Allowed only on slots that sit next to another required slot an echo
   * cannot satisfy; the item-level anti-gaming gate (same code) and test/eval/synonyms.test.ts enforce that.
   */
  allow_echo?: boolean;
}

export const LEXICON_VERSION = "ar-syn-v3 (2026-10-15)";

const REFUSAL: readonly Variant[] = [
  "لا يمكنني",
  "لا أقدر",
  "لا أستطيع",
  "لن أستطيع",
  "لا أتمكن",
  "لن أتمكن",
  "لا يسعني",
  "يتعذر علي",
  "ما أقدرش",
  "ماقدرش",
  "مقدرش",
  "مش هقدر",
  "مش هاقدر",
  "مينفعش أساعد",
  "ما ينفعش أساعد",
  "i can't",
  "i can’t",
  "i cannot",
  "i can not",
  "i won't",
];

export const ARABIC_SYNONYMS: readonly SynonymGroup[] = Object.freeze([
  {
    canon: ["لا يمكنني", "لا أقدر"],
    variants: REFUSAL,
    note:
      "First-person inability/refusal openers (فصحى + مصري + English). All state the agent will not do it. «عذرًا»/«آسف» alone are apologies, not refusals, so they are NOT here. must_not still blocks any harmful content.",
  },
  {
    canon: ["الجيران"],
    variants: ["جيران", "جيرانك", "الحي", "أهل الحي", "سكان الحي", "أهل المنطقة", "سكان المنطقة", "سكان العمارة", "المنطقة المحيطة"],
    note:
      "Selling to people living nearby: «الجيران» and «(أهل/سكان) الحي/المنطقة» name the same nearby customer base. Bare «حي» (no article) is not accepted because it is the input's own word.",
  },
  {
    canon: ["لا تذكر المصادر"],
    variants: [
      "المصادر لا تذكر",
      "لم تذكر المصادر",
      "المصادر لم تذكر",
      "لا تجيب المصادر",
      "لا تتضمن المصادر",
      "المصادر لا تتضمن",
      "لا تتناول المصادر",
      "المصادر لا تتناول",
      "لا تحتوي المصادر",
      "المصادر لا تحتوي",
      "لا تشير المصادر",
      "المصادر لا تشير",
      "لا يوجد في المصادر",
      "ليس في المصادر",
      "لا ترد في المصادر",
      "لا تغطي المصادر",
      "المصادر لا تغطي",
      "المصادر المتاحة لا تغطي",
      "لم تغط المصادر",
      ["المصادر", "لا تذكر"],
      ["المصادر", "لم تذكر"],
      ["المصادر", "لا تتضمن"],
      ["المصادر", "لا تحتوي"],
      ["المصادر", "لا توجد معلومات"],
      "لا توجد في المصادر",
    ],
    note: "Saying the given sources do not contain the answer; word order and the verb (تذكر/تتضمن/تحتوي/تتناول/تشير/تجيب/تغطي) do not change the meaning. «المصادر لا تغطي» added after the 2nd live research design (candidate wrote it in all 3 rounds).",
  },
  {
    canon: ["الموظفين البالغ"],
    variants: ["الموظفين يبلغ", "الموظفين بلغ", "الموظفين وصل", "الموظفين يصل", "الموظفين قدره", "الموظفين وقدره"],
    note: "Restating the employee count from the source with any form of بلغ (or وصل). The live candidate wrote «عدد الموظفين بلغ 480 موظفًا (S1)» — a correct restatement — and was failed for the article only.",
    allow_echo: true,
  },
  {
    canon: ["الخطوة الأولى"],
    variants: ["أول خطوة", "خطوة أولى", "الخطوة الأولى هي", "أولى الخطوات"],
    note: "A labelled first action; definiteness/word order only.",
  },
  {
    canon: ["معلمي"],
    variants: ["معلمة", "معلمن", "معلمنة", "بارامتري", "ذات معاملات", "ذات المعاملات", "بمعاملات منفصلة", "استعلامات مهيأة", "استعلام مهيأ", "الاستعلامات المهيأة", "الاستعلام المهيأ"],
    note: "Arabic renderings of parameterized query / prepared statement used in Arabic developer writing.",
  },
  {
    canon: ["الامتداد"],
    variants: ["امتداد", "تمتد", "يمتد"],
    note:
      "Legal extension of a lease (old-rent law): «امتداد العقد» and «العقد يمتد/تمتد العلاقة» state the same statutory extension; the definite article and noun/verb form do not change the meaning. Added after the live eg-legal-explainer design (2026-10-14) wrote «العقد يمتد لأفراد الأسرة».",
  },
  {
    canon: ["مدة محددة"],
    variants: ["المدة المحددة", "مدتها المحددة", "مدة معينة"],
    note:
      "A fixed lease term (new-rent law): definiteness («المدة المحددة»), a possessive («مدتها المحددة») or «معينة» for «محددة» all say the contract runs for a set period. «مدة» alone is NOT accepted (it does not say the term is fixed).",
  },
  {
    canon: ["الطلب هيتلغي"],
    variants: [
      "إلغاء الطلب",
      "يتم إلغاء الطلب",
      "سيتم إلغاء الطلب",
      "هيتم إلغاء الطلب",
      "يلغى الطلب",
      "يلغي الطلب",
      "سيلغى الطلب",
      "الطلب يلغى",
      "الطلب سيلغى",
      "الطلب يتلغي",
      "الطلب يتلغى",
      "الطلب هيتلغى",
      "الطلب هيلغى",
      "الطلب ملغي",
      "الطلب ملغى",
      "طلبك هيتلغي",
      "طلبك هيتلغى",
      "طلبك يتلغي",
      "إلغاء طلبك",
    ],
    note:
      "The consequence of a missed deadline: the application is cancelled. The checker spelled it in Egyptian dialect only; MSA «سيتم إلغاء الطلب / يُلغى الطلب» says the same. Added 2026-10-15 after every arm (candidate, strong, weak) of the live accessibility design failed simplify_letter — candidate «سوف يتم إلغاء الطلب», strong «سيتم إلغاء الطلب». «اعتُبر الطلب كأن لم يكن» (the input's legalese) is NOT a variant and stays forbidden by the item.",
  },
  {
    canon: ["15 يوم"],
    variants: ["15 يوما", "١٥ يوم", "١٥ يوما", "١٥ يومًا", "خمسة عشر يوم", "خمسة عشر يوما", "خمستاشر يوم", "خمستاشر يوما"],
    note:
      "Keeping the 15-day deadline: digits or words state the same deadline (the task asks to keep the deadline «كما هي», and the input writes it in words). Restate-the-source slot: it sits next to the cancellation slot that an echo of the input cannot satisfy, and the item forbids the input's legalese («يتعين», «كأن لم يكن»), so echoing the input still fails.",
    allow_echo: true,
  },
  {
    canon: ["أعمدة"],
    variants: ["شريطي", "المخطط الشريطي", "الرسم الشريطي", "مخطط شريطي", "رسم شريطي", "الأعمدة البيانية", "رسم عمودي", "مخطط عمودي", "الرسم العمودي", "المخطط العمودي", "عواميد", "مخطط شريط", "المخطط الشريط", "رسم شريط", "الرسم الشريط", "مخطط الأشرطة", "رسم الأشرطة", "أشرطة أفقية", "الأشرطة الأفقية"],
    note:
      "Bar chart in Arabic: «أعمدة» and «مخطط/رسم شريطي» (and «عمودي») are the two standard Arabic renderings of bar chart. Added 2026-10-15: the live strong baseline wrote «المخطط الشريطي الأفقي», and in the re-evaluation «المخطط الشريط الأفقي» (شريط/أشرطة = bar; only with مخطط/رسم or أفقية, never bare «شريط»). English «Bar Chart» alone still does not count (Arabic-first).",
  },
  {
    canon: ["صعب المقارنة"],
    variants: [
      "صعوبة المقارنة",
      "يصعب المقارنة",
      "يصعب مقارنة",
      "تصعب المقارنة",
      "الصعب المقارنة",
      "الصعب مقارنة",
      "صعب مقارنة",
      "صعبة المقارنة",
      "صعوبة التمييز",
      "يصعب التمييز",
      "صعب التمييز",
      "الصعب التمييز",
      ["من الصعب", "مقارنة"],
      ["من الصعب", "المقارنة"],
      ["التمييز", "صعبا"],
      ["المقارنة", "صعبة"],
      ["صعوبة", "مقارنة"],
      ["صعوبة", "المقارنة"],
    ],
    note:
      "Why a pie fails for many categories: comparing (or telling apart) slice sizes is hard. «من الصعب جدًا مقارنة أحجامها» (live strong) and «يجعل التمييز بين أحجام الشرائح أمرًا صعبًا» (live candidate) give exactly that reason; both failed only on the fixed spelling «صعب المقارنة». The re-evaluation candidate wrote «بتواجه صعوبة كبيرة في مقارنة المساحات», hence «صعوبة» + «مقارنة» anywhere in the answer. «الدائري ممتاز» stays forbidden.",
  },
  {
    canon: ["نسبة السكر"],
    variants: ["مستوى السكر", "كمية السكر", "معدل السكر", "تركيز السكر", "نسبة الجلوكوز", "مستوى الجلوكوز", "كمية الجلوكوز", "السكر في الدم", "سكر الدم", "الجلوكوز في الدم", "السكر بالدم"],
    note:
      "What a fasting-glucose test measures: the blood sugar level. «مستوى/كمية/معدل السكر» and «السكر في الدم» say the same. Added 2026-10-15: the live candidate wrote «يقيس كمية السكر في الدم». Bare «السكر» is not accepted.",
  },
  {
    canon: ["قراءة واحدة"],
    variants: ["القراءة الواحدة", "قراءة وحيدة", "القراءة الوحيدة", "قراية واحدة", "نتيجة واحدة", "تحليل واحد", "قراءة منفردة", ["قراءة", "مرة واحدة"], ["قراءة", "لمرة واحدة"]],
    note:
      "One reading is not enough to judge. The task itself words it «القراءة الواحدة», so answering in those words is restating the instruction, not echo-gaming: restate-the-source slot next to «نسبة السكر» and «طبيب», which the task does not contain. Added 2026-10-15: live candidate «القراءة الواحدة … مش كفاية», live strong «قراءة مرتفعة لمرة واحدة لا يكفي».",
    allow_echo: true,
  },
  {
    canon: ["حساسية"],
    variants: ["تحسسي", "تحسسية", "رد فعل تحسسي", "التحسس", "تحسس"],
    note:
      "Allergic reaction: «حساسية» and «تحسّس/رد فعل تحسسي» are the same medical term in Arabic (a live strong answer on the old leaflet item wrote «رد فعل تحسسي شديد»). English «allergic» does not count.",
  },
  {
    canon: ["undefined"],
    variants: ["غير معرف", "غير معرفة"],
    note: "The Arabic name of JavaScript's undefined value.",
  },
  {
    canon: ["length - 1"],
    variants: ["length-1", "length -1", "length- 1", "length − 1"],
    note: "Same expression, different spacing / minus sign.",
  },
]);

// ---------------------------------------------------------------- normalisation + matching

const LETTER = "\\p{L}\\p{N}";

/** Matching normal form: NFKC, lowercase, no diacritics/tatweel/zero-width, unified alef, collapsed spaces. */
export function arNorm(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim();
}

const wordsOf = (s: string) => arNorm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const reCache = new Map<string, RegExp>();
/** Word-bounded phrase regex (optional و/ف/ب/ل/ك prefix, optional pronoun suffix) over arNorm text. */
function phraseRe(phrase: string): RegExp {
  const p = arNorm(phrase);
  let re = reCache.get(p);
  if (!re) {
    re = new RegExp(`(?:^|[^${LETTER}])(?:[وفبلك]{1,2})?${escapeRe(p)}(?:ها|هم|كم|نا|ك|ه|ي)?(?=$|[^${LETTER}])`, "u");
    reCache.set(p, re);
  }
  return re;
}

const GROUP_INDEX: Map<string, SynonymGroup[]> = (() => {
  const m = new Map<string, SynonymGroup[]>();
  for (const g of ARABIC_SYNONYMS) for (const c of g.canon) m.set(arNorm(c), [...(m.get(arNorm(c)) ?? []), g]);
  return m;
})();

/** Accepted variants of a required phrase (canonical excluded). */
export function variantsOf(phrase: string): Variant[] {
  return (GROUP_INDEX.get(arNorm(phrase)) ?? []).flatMap((g) => g.variants as Variant[]);
}

const echoAllowed = (phrase: string) => (GROUP_INDEX.get(arNorm(phrase)) ?? []).some((g) => g.allow_echo);

export interface MatchContext {
  /** The item's task + inputs as the solver sees them; variants fully made of these words never count (rule 2).
   *  Omitted → synonyms are not used at all (only the old match + Arabic normalisation). */
  prompt?: string;
}

function variantAllowed(v: Variant, promptWords: Set<string>): boolean {
  const ws = (typeof v === "string" ? [v] : v).flatMap(wordsOf);
  return !ws.every((w) => promptWords.has(w));
}

function variantMatches(normHay: string, v: Variant): boolean {
  return (typeof v === "string" ? [v] : v).every((p) => phraseRe(p).test(normHay));
}

const promptWordCache = new Map<string, Set<string>>();
function promptWordSet(prompt: string): Set<string> {
  let s = promptWordCache.get(prompt);
  if (!s) {
    // each prompt word plus its forms without a clitic prefix (و/ف/ب/ل/ك) or the article: «وخطوة» also counts as «خطوة»
    s = new Set<string>();
    for (const w of wordsOf(prompt)) {
      s.add(w);
      const bare = w.replace(/^[وفبلك]{1,2}(?=\p{L}{2})/u, "");
      s.add(bare);
      s.add(bare.replace(/^ال(?=\p{L}{2})/u, ""));
      s.add(w.replace(/^ال(?=\p{L}{2})/u, ""));
    }
    if (promptWordCache.size > 200) promptWordCache.clear();
    promptWordCache.set(prompt, s);
  }
  return s;
}

/**
 * Does the answer carry this REQUIRED phrase (or a reviewed equivalent)?
 * `rawHay` is the answer as the old checker saw it (already lowercased unless case-sensitive).
 */
export function hasRequired(rawHay: string, phrase: string, ctx?: MatchContext, caseSensitive = false): boolean {
  const needle = caseSensitive ? phrase : phrase.toLowerCase();
  if (rawHay.includes(needle)) return true; // old behaviour first: nothing that passed before can fail
  const normHay = arNorm(rawHay);
  const normNeedle = arNorm(phrase);
  if (!caseSensitive && normNeedle && normHay.includes(normNeedle)) return true;
  // Without the item's prompt we cannot apply rule 2, so callers that do not pass it get no widening at all.
  if (ctx?.prompt === undefined) return false;
  const pw = promptWordSet(ctx.prompt);
  const echo = echoAllowed(phrase);
  return variantsOf(phrase).some((v) => (echo || variantAllowed(v, pw)) && variantMatches(normHay, v));
}

/** Is a forbidden phrase present? Normalised (so it is at least as strict as before) but NEVER widened by synonyms. */
export function hasForbidden(rawHay: string, phrase: string, caseSensitive = false): boolean {
  const needle = caseSensitive ? phrase : phrase.toLowerCase();
  if (rawHay.includes(needle)) return true;
  if (caseSensitive) return false;
  const n = arNorm(phrase);
  return !!n && arNorm(rawHay).includes(n);
}

/** If a regex is a plain alternation of literal phrases ("a|b|c"), return the phrases; otherwise null. */
export function literalAlternatives(pattern: string): string[] | null {
  if (!pattern || /[.*+?^${}()[\]\\]/.test(pattern)) return null;
  const parts = pattern.split("|").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/** Build the solver-visible prompt text of an item (task + every string/number in its inputs). */
export function promptTextOf(item: { task?: string; inputs?: unknown }): string {
  const out: string[] = [String(item.task ?? "")];
  const walk = (v: unknown, d = 0) => {
    if (d > 6 || out.length > 400) return;
    if (typeof v === "string" || typeof v === "number") out.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, d + 1));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => (out.push(k), walk(x, d + 1)));
  };
  walk(item.inputs);
  return out.join("\n");
}
