/**
 * Judge Court probe bank: small rubric items written in BOTH English and Arabic with known answer relations.
 *  good / good2  equal quality (both cover every criterion) → position probe: a fair judge ties or is order-stable
 *  weak          clearly worse (misses the evidence)        → gold anchor: the right winner is known
 *  padding       neutral filler appended to `good`         → verbosity probe: padding must not win
 * The AR and EN versions say the same thing, so a judge's verdict should not change with the language.
 * Every answer ends with a full stop (the rubric treats long unpunctuated text as keyword stuffing).
 */
import type { RubricCriterion } from "../eval/types";

export type Lang = "en" | "ar";
export interface Bi<T> {
  en: T;
  ar: T;
}
export interface ProbeItem {
  key: string;
  task: Bi<string>;
  criteria: Bi<RubricCriterion[]>;
  good: Bi<string>;
  good2: Bi<string>;
  weak: Bi<string>;
}

export const PADDING: Bi<string> = {
  en: " Computers have become common in offices around the world over the past decades. Many people use them every day for email and documents. Technology keeps changing quickly, and new devices appear every year.",
  ar: " أصبحت الحواسيب شائعة في المكاتب حول العالم خلال العقود الماضية. يستخدمها كثير من الناس يوميا للبريد والمستندات. والتقنية تتغير بسرعة وتظهر أجهزة جديدة كل عام.",
};

const c = (id: string, desc: string, keywords: string[]): RubricCriterion => ({ id, desc, keywords });

export const PROBE_BANK: ProbeItem[] = [
  {
    key: "backup",
    task: { en: "Explain briefly why a small business should back up its data.", ar: "اشرح باختصار لماذا يجب على شركة صغيرة أن تحتفظ بنسخ احتياطية من بياناتها." },
    criteria: {
      en: [c("loss", "Mentions protection against data loss (e.g. ransomware or disk failure)", ["data loss", "ransomware"]), c("restore", "Mentions restoring work quickly", ["restore"])],
      ar: [c("loss", "يذكر الحماية من فقدان البيانات (مثل برامج الفدية أو تعطل القرص)", ["فقدان البيانات", "برامج الفدية"]), c("restore", "يذكر استعادة العمل بسرعة", ["استعادة"])],
    },
    good: {
      en: "Backups protect against data loss from broken disks or ransomware, and let the business restore its files and keep working within hours.",
      ar: "النسخ الاحتياطية تحمي من فقدان البيانات بسبب تعطل الأقراص أو برامج الفدية، وتسمح للشركة باستعادة ملفاتها ومواصلة العمل خلال ساعات.",
    },
    good2: {
      en: "If ransomware or a failed drive causes data loss, a recent backup lets the company restore everything quickly and avoid long downtime.",
      ar: "إذا تسببت برامج الفدية أو عطل في القرص في فقدان البيانات، فإن وجود نسخة حديثة يتيح استعادة كل شيء بسرعة وتجنب التوقف الطويل.",
    },
    weak: { en: "Backups are a good idea because computers are useful for many tasks in a business.", ar: "النسخ الاحتياطية فكرة جيدة لأن الحواسيب مفيدة في مهام كثيرة داخل الشركة." },
  },
  {
    key: "water",
    task: { en: "Give two practical ways a household can save water.", ar: "اذكر طريقتين عمليتين لتوفير الماء في المنزل." },
    criteria: {
      en: [c("leak", "Fixing leaks", ["leak"]), c("shower", "Shorter showers", ["shorter shower"])],
      ar: [c("leak", "إصلاح التسريبات", ["تسريب"]), c("shower", "الاستحمام لوقت أقصر", ["دش أقصر"])],
    },
    good: { en: "Fix any leak in taps and pipes quickly, and take a shorter shower each day to cut usage.", ar: "أصلح أي تسريب في الصنابير والأنابيب بسرعة، وخذ دش أقصر كل يوم لتقليل الاستهلاك." },
    good2: { en: "Take a shorter shower and repair every dripping leak as soon as you notice it, since both save many litres.", ar: "خذ دش أقصر وأصلح كل تسريب تلاحظه فورا، فكلاهما يوفر لترات كثيرة." },
    weak: { en: "Water is important for life, so people should think about it.", ar: "الماء مهم للحياة، لذلك يجب على الناس التفكير فيه." },
  },
  {
    key: "photosynthesis",
    task: { en: "In one or two sentences, what does photosynthesis do?", ar: "في جملة أو جملتين، ماذا يفعل البناء الضوئي؟" },
    criteria: {
      en: [c("inputs", "Names the inputs: sunlight and carbon dioxide", ["sunlight", "carbon dioxide"]), c("outputs", "Names oxygen as a product", ["oxygen"])],
      ar: [c("inputs", "يذكر المدخلات: ضوء الشمس وثاني أكسيد الكربون", ["ضوء الشمس", "ثاني أكسيد الكربون"]), c("outputs", "يذكر الأكسجين كناتج", ["الأكسجين"])],
    },
    good: { en: "Photosynthesis lets plants use sunlight to turn carbon dioxide and water into sugar, releasing oxygen.", ar: "البناء الضوئي يتيح للنباتات استخدام ضوء الشمس لتحويل ثاني أكسيد الكربون والماء إلى سكر مع إطلاق الأكسجين." },
    good2: { en: "Using energy from sunlight, plants convert carbon dioxide and water into glucose and give off oxygen.", ar: "باستخدام طاقة ضوء الشمس تحول النباتات ثاني أكسيد الكربون والماء إلى جلوكوز وتطلق الأكسجين." },
    weak: { en: "Photosynthesis is something plants do in nature.", ar: "البناء الضوئي شيء تقوم به النباتات في الطبيعة." },
  },
  {
    key: "phishing",
    task: { en: "What should someone do first after receiving an unexpected password-reset email?", ar: "ماذا يجب أن يفعل الشخص أولا عند وصول رسالة غير متوقعة لإعادة تعيين كلمة المرور؟" },
    criteria: {
      en: [c("noclick", "Says not to click the link", ["do not click"]), c("official", "Says to go to the official website directly", ["official website"])],
      ar: [c("noclick", "ينصح بعدم الضغط على الرابط", ["لا تضغط"]), c("official", "ينصح بالذهاب إلى الموقع الرسمي مباشرة", ["الموقع الرسمي"])],
    },
    good: { en: "Do not click the link in the email; instead open the official website yourself and check your account security there.", ar: "لا تضغط على الرابط في الرسالة، بل افتح الموقع الرسمي بنفسك وتحقق من أمان حسابك هناك." },
    good2: { en: "Go to the official website by typing its address yourself, and do not click any link in that message.", ar: "اذهب إلى الموقع الرسمي بكتابة عنوانه بنفسك، ولا تضغط على أي رابط في تلك الرسالة." },
    weak: { en: "Emails can be confusing and people get many of them.", ar: "رسائل البريد قد تكون مربكة ويصل للناس الكثير منها." },
  },
  {
    key: "sleep",
    task: { en: "Why is regular sleep important for students?", ar: "لماذا يعد النوم المنتظم مهما للطلاب؟" },
    criteria: {
      en: [c("memory", "Mentions memory", ["memory"]), c("focus", "Mentions concentration", ["concentration"])],
      ar: [c("memory", "يذكر الذاكرة", ["الذاكرة"]), c("focus", "يذكر التركيز", ["التركيز"])],
    },
    good: { en: "Regular sleep helps the brain store memory from the day and improves concentration in class.", ar: "النوم المنتظم يساعد الدماغ على تثبيت الذاكرة ويحسن التركيز أثناء الدروس." },
    good2: { en: "Students who sleep regularly keep better concentration, and their memory of lessons is stronger.", ar: "الطلاب الذين ينامون بانتظام يحافظون على التركيز وتكون الذاكرة لديهم أقوى في الدروس." },
    weak: { en: "Sleep happens at night and most people do it.", ar: "النوم يحدث ليلا ومعظم الناس يفعلونه." },
  },
  {
    key: "citations",
    task: { en: "Why should a report cite its sources?", ar: "لماذا يجب أن يذكر التقرير مصادره؟" },
    criteria: {
      en: [c("verify", "Readers can verify claims", ["verify"]), c("cred", "Builds credibility", ["credibility"])],
      ar: [c("verify", "يمكّن القراء من التحقق", ["التحقق"]), c("cred", "يمنح المصداقية", ["المصداقية"])],
    },
    good: { en: "Citing sources lets readers verify each claim and gives the report credibility.", ar: "ذكر المصادر يتيح للقراء التحقق من كل ادعاء ويمنح التقرير المصداقية." },
    good2: { en: "A report gains credibility when it cites sources, because readers can verify the facts themselves.", ar: "يكتسب التقرير المصداقية عندما يذكر مصادره، لأن القراء يستطيعون التحقق من الحقائق بأنفسهم." },
    weak: { en: "Reports are documents that people write at work.", ar: "التقارير مستندات يكتبها الناس في العمل." },
  },
];

export const PROBE_MAP: Record<string, ProbeItem> = Object.fromEntries(PROBE_BANK.map((p) => [p.key, p]));

/** Share of rubric evidence an answer covers (deterministic; used to check two answers are of equal quality). */
export function coverage(answer: string, criteria: RubricCriterion[]): number {
  const a = answer.toLowerCase();
  const kws = criteria.flatMap((c) => c.keywords ?? []);
  if (!kws.length) return 1;
  return kws.filter((k) => a.includes(k.toLowerCase())).length / kws.length;
}
