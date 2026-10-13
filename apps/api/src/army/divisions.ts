/**
 * The 9 divisions (corps) of the Free Agent Army — KHALIYA_MASTER_PLAN §2.1 — mapped onto the roles that exist in
 * constitution.ts today. Divisions whose roles are not built yet (operator, support, compliance, finance, teacher,
 * redteam/blueteam/forensics) are "hosted" by the existing role whose constitutional tier ceiling fits; the planned
 * role names are kept so the mapping can be switched when those roles land in the constitution (owner-only change).
 * Division tier caps can only LOWER the role ceiling from constitution.ts, never raise it.
 */
import { CONSTITUTION, type Role, type Tier } from "../constitution";

export type DivisionId = "builders" | "researchers" | "operators" | "sales_support" | "legal" | "security" | "finance" | "quality" | "teachers";

export interface Division {
  id: DivisionId;
  name_en: string;
  name_ar: string;
  /** Existing roles whose PRIMARY division this is. */
  roles: Role[];
  /** Existing role that hosts the division's planned roles until they exist. */
  host_role: Role;
  /** Roles from the master plan not yet in the constitution. */
  planned_roles: string[];
  tier_cap: Tier;
  /** Actions above tier_cap that the division may only DRAFT (e.g. operators' T4 draft-only). */
  draft_only_above_cap: boolean;
  judged_by: string[];
  mission: string;
  mission_ar: string;
}

function freeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o as object).forEach(freeze);
    Object.freeze(o);
  }
  return o;
}

export const DIVISIONS: readonly Division[] = freeze([
  { id: "builders", name_en: "Builders", name_ar: "البنّاؤون", roles: ["builder", "toolsmith", "architect"], host_role: "builder", planned_roles: [], tier_cap: 2, draft_only_above_cap: false, judged_by: ["quality", "security"], mission: "code, Forge tools, Studio agent design", mission_ar: "البرمجة، أدوات المصهر، وتصميم وكلاء الاستوديو" },
  { id: "researchers", name_en: "Researchers", name_ar: "الباحثون", roles: ["researcher", "librarian"], host_role: "researcher", planned_roles: [], tier_cap: 3, draft_only_above_cap: false, judged_by: ["quality"], mission: "cited research, KB, summaries (external read with approval)", mission_ar: "بحث موثّق بالمصادر، قاعدة المعرفة، والملخّصات (القراءة الخارجية بموافقة)" },
  { id: "operators", name_en: "Operators", name_ar: "المشغّلون", roles: ["director"], host_role: "builder", planned_roles: ["operator"], tier_cap: 2, draft_only_above_cap: true, judged_by: ["security", "owner"], mission: "customer errands: drafts, sheets, files — customer presses execute", mission_ar: "مهام العملاء: مسودات وجداول وملفات — والعميل هو من يضغط تنفيذ" },
  { id: "sales_support", name_en: "Sales & Support", name_ar: "المبيعات والدعم", roles: [], host_role: "librarian", planned_roles: ["support", "onboarding"], tier_cap: 1, draft_only_above_cap: true, judged_by: ["legal", "owner"], mission: "answer customers; never promise prices/refunds outside policy", mission_ar: "الرد على العملاء؛ دون وعود بأسعار أو استرداد خارج السياسة أبدًا" },
  { id: "legal", name_en: "Legal & Compliance", name_ar: "القانون والامتثال", roles: [], host_role: "critic", planned_roles: ["compliance"], tier_cap: 1, draft_only_above_cap: false, judged_by: ["human_lawyer", "owner"], mission: "review legal texts, RoPA, deadlines; no legal advice to customers", mission_ar: "مراجعة النصوص القانونية وسجل المعالجة والمواعيد؛ دون تقديم استشارة قانونية للعملاء" },
  { id: "security", name_en: "Security", name_ar: "الأمن", roles: [], host_role: "evaluator", planned_roles: ["redteam", "blueteam", "forensics"], tier_cap: 2, draft_only_above_cap: false, judged_by: ["security_council", "owner"], mission: "attack, defend, investigate (sandbox)", mission_ar: "هجوم ودفاع وتحقيق (داخل الحاوية)" },
  { id: "finance", name_en: "Finance", name_ar: "المالية", roles: [], host_role: "librarian", planned_roles: ["finance"], tier_cap: 1, draft_only_above_cap: true, judged_by: ["owner"], mission: "read-only revenue/cost/margins; any money movement = two-key", mission_ar: "قراءة فقط للإيرادات والتكاليف والهوامش؛ وأي حركة مال = مفتاحان" },
  { id: "quality", name_en: "Quality & Judges", name_ar: "الجودة والقضاة", roles: ["evaluator", "critic", "auditor"], host_role: "evaluator", planned_roles: [], tier_cap: 1, draft_only_above_cap: false, judged_by: ["court_meta_review"], mission: "evaluate, judge, audit (protected lineages, art. 6)", mission_ar: "تقييم وتحكيم وتدقيق (سلالات محمية، المادة 6)" },
  { id: "teachers", name_en: "Teachers", name_ar: "المعلّمون", roles: [], host_role: "librarian", planned_roles: ["teacher"], tier_cap: 1, draft_only_above_cap: false, judged_by: ["quality"], mission: "turn failure lessons into playbooks and drills", mission_ar: "تحويل دروس الإخفاق إلى أدلة عمل وتدريبات" },
]);

export const DIVISION_IDS = DIVISIONS.map((d) => d.id) as DivisionId[];
export const DIVISION_MAP: Readonly<Record<DivisionId, Division>> = Object.freeze(Object.fromEntries(DIVISIONS.map((d) => [d.id, d])) as Record<DivisionId, Division>);

export const isDivision = (s: unknown): s is DivisionId => typeof s === "string" && (DIVISION_IDS as string[]).includes(s);

/** Primary division for an existing role (every constitutional role maps to exactly one). */
export function divisionForRole(role: string): DivisionId {
  for (const d of DIVISIONS) if ((d.roles as string[]).includes(role)) return d.id;
  for (const d of DIVISIONS) if (d.planned_roles.includes(role)) return d.id;
  return "builders";
}

/** Effective tier ceiling: min(constitution role ceiling, division cap). */
export function effectiveTierCap(role: string, division: DivisionId): Tier {
  const roleCap = CONSTITUTION.roleMaxTier[role as Role] ?? 0;
  return Math.min(roleCap, DIVISION_MAP[division].tier_cap) as Tier;
}

/** Is the role allowed to serve in the division (primary member or the host role)? */
export function roleFitsDivision(role: string, division: DivisionId): boolean {
  const d = DIVISION_MAP[division];
  return (d.roles as string[]).includes(role) || d.host_role === role;
}
