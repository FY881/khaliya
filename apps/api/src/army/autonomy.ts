/**
 * Autonomy ladder L0–L5 (master plan §2.8) and the approval matrix: action class × risk tier → approvers (§3.2),
 * with the two-key rule (§3.3). All pure and deep-frozen. Nothing here can grant a change to the constitution,
 * governor, audit, verifiers or protected lineages — "core_change" is forbidden at every level, including L5.
 *
 * Approvers are the four authorities the army knows: auto | court | security_council | owner. A customer key is
 * not modelled yet (no customer accounts); where the plan says "customer + Omar" the owner key is required and the
 * second key must come from court or security_council (two-key).
 */
export type AutonomyLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
export const AUTONOMY_LEVELS: AutonomyLevel[] = ["L0", "L1", "L2", "L3", "L4", "L5"];
export const levelNum = (l: AutonomyLevel) => AUTONOMY_LEVELS.indexOf(l);
export const isAutonomy = (s: unknown): s is AutonomyLevel => typeof s === "string" && (AUTONOMY_LEVELS as string[]).includes(s);
export const minLevel = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel => (levelNum(a) <= levelNum(b) ? a : b);

/** Risk tiers (§3.2): 0 internal no effect · 1 internal reversible · 2 touches customer data · 3 external reversible · 4 irreversible / money / publish. */
export type RiskTier = 0 | 1 | 2 | 3 | 4;
export const RISK_TIERS: RiskTier[] = [0, 1, 2, 3, 4];
export const isRisk = (n: unknown): n is RiskTier => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 4;

export type ActionClass =
  | "think_memory"
  | "sandbox_code"
  | "evolution"
  | "customer_reply"
  | "customer_action"
  | "external_comms"
  | "money"
  | "publish"
  | "data_export"
  | "bylaws_change"
  | "core_change";
export const ACTION_CLASSES: ActionClass[] = ["think_memory", "sandbox_code", "evolution", "customer_reply", "customer_action", "external_comms", "money", "publish", "data_export", "bylaws_change", "core_change"];
export const isActionClass = (s: unknown): s is ActionClass => typeof s === "string" && (ACTION_CLASSES as string[]).includes(s);

/** §3.3: these always need the owner key plus one more key, at every risk tier. */
export const TWO_KEY_CLASSES: readonly ActionClass[] = Object.freeze(["money", "publish", "external_comms", "data_export"] as ActionClass[]);

export type Approver = "auto" | "court" | "security_council" | "owner";
export const APPROVERS: Approver[] = ["auto", "court", "security_council", "owner"];

export interface MatrixCell {
  /** null = not a valid combination / forbidden to agents. */
  approvers: Approver[] | null;
  two_key: boolean;
  /** Owner key must be a fresh TOTP (step-up). */
  step_up: boolean;
  note?: string;
}

function freeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o as object).forEach(freeze);
    Object.freeze(o);
  }
  return o;
}

const X: MatrixCell = { approvers: null, two_key: false, step_up: false };
const c = (approvers: Approver[], note?: string, step_up = false): MatrixCell => ({ approvers, two_key: false, step_up, note });
const tk = (second: Approver[], note?: string, step_up = true): MatrixCell => ({ approvers: ["owner", ...second], two_key: true, step_up, note });

/** Rows follow the master plan table; two-key classes carry owner + (court | security_council). */
export const APPROVAL_MATRIX: Readonly<Record<ActionClass, readonly MatrixCell[]>> = freeze({
  think_memory: [c(["auto"]), c(["auto"]), c(["auto"], "inside the tenant"), X, X],
  sandbox_code: [c(["auto"]), c(["court"], "admission"), c(["court", "security_council"]), X, X],
  evolution: [c(["auto"], "automatic gate"), c(["auto"], "gate + canary"), c(["court"], "gate + red-team + judge"), c(["security_council"]), c(["owner"])],
  customer_reply: [X, X, c(["auto"], "L3 + DLP"), X, X],
  customer_action: [X, X, c(["auto"], "draft only"), c(["security_council"], "customer consent + security"), tk(["security_council"], "customer + owner")],
  external_comms: [X, X, X, tk(["court"], "legal agent + owner", false), tk(["court"], "owner + TOTP")],
  money: [X, X, X, X, tk(["security_council"], "finance prepares, owner signs with TOTP")],
  publish: [X, X, X, tk(["security_council"], "security + legal + owner", false), tk(["security_council"], "owner + TOTP")],
  data_export: [X, X, tk(["court"], "customer DSAR + owner", false), tk(["security_council"], "compliance + security + owner", false), tk(["security_council"], "customer + owner")],
  bylaws_change: [X, X, X, c(["court", "security_council"]), c(["owner"])],
  core_change: [X, X, X, X, X],
});

/** Minimum autonomy level an agent needs to use an "auto" cell without per-action approval. */
export const AUTO_MIN_LEVEL: Readonly<Partial<Record<ActionClass, AutonomyLevel>>> = freeze({
  think_memory: "L0",
  sandbox_code: "L2",
  evolution: "L2",
  customer_reply: "L3",
  customer_action: "L3",
});

export interface LadderRung {
  level: AutonomyLevel;
  name_en: string;
  name_ar: string;
  without_approval: string;
  needs_approval: string;
  without_approval_ar: string;
  needs_approval_ar: string;
  reached_by: string;
  /** Highest risk tier the level reaches through the normal matrix approvers (above it, only the owner can route it). */
  max_risk: RiskTier;
  owner_only: boolean;
}

export const AUTONOMY_LADDER: readonly LadderRung[] = freeze([
  { level: "L0", name_en: "Observer", name_ar: "مراقب", without_approval: "thinking and its own memory", needs_approval: "everything else", without_approval_ar: "التفكير وذاكرته الخاصة", needs_approval_ar: "كل ما عدا ذلك", reached_by: "default for any new agent", max_risk: 0, owner_only: false },
  { level: "L1", name_en: "Assistant", name_ar: "مساعد", without_approval: "internal T1 tools, KB read", needs_approval: "T2 and above", without_approval_ar: "أدوات T1 الداخلية، وقراءة قاعدة المعرفة", needs_approval_ar: "T2 فما فوق", reached_by: "admission", max_risk: 1, owner_only: false },
  { level: "L2", name_en: "Internal executor", name_ar: "منفّذ داخلي", without_approval: "sandbox (T2) and contracted internal missions", needs_approval: "anything touching a customer", without_approval_ar: "الحاوية (T2) والمهام الداخلية المتعاقد عليها", needs_approval_ar: "كل ما يمسّ عميلًا", reached_by: "R1 + red-team", max_risk: 1, owner_only: false },
  { level: "L3", name_en: "Customer executor", name_ar: "منفّذ للعميل", without_approval: "customer missions with outputs only (text, files, drafts) inside the tenant", needs_approval: "any external action", without_approval_ar: "مهام العملاء بمخرجات فقط (نصوص وملفات ومسودات) داخل المستأجر", needs_approval_ar: "أي فعل خارجي", reached_by: "R2 + Judge Court", max_risk: 2, owner_only: false },
  { level: "L4", name_en: "Operator", name_ar: "مشغّل", without_approval: "allowlisted external read (T3), swarm management, reversible external actions with one-time customer consent", needs_approval: "spend, publish, data export (two-key)", without_approval_ar: "قراءة خارجية من قائمة مسموحة (T3)، إدارة السرب، وأفعال خارجية قابلة للتراجع بموافقة العميل لمرة واحدة", needs_approval_ar: "الإنفاق والنشر وتصدير البيانات (مفتاحان)", reached_by: "R3 + Security Council + owner", max_risk: 3, owner_only: false },
  { level: "L5", name_en: "Fully autonomous", name_ar: "مستقل كامل", without_approval: "long missions with several external actions inside a mission contract signed by the owner", needs_approval: "anything outside the contract", without_approval_ar: "مهام طويلة بعدة أفعال خارجية ضمن عقد مهمة يوقّعه المالك", needs_approval_ar: "كل ما هو خارج العقد", reached_by: "owner only, per mission, max 7 days", max_risk: 4, owner_only: true },
]);

export const L5_MAX_DAYS = 7;
export const L5_MAX_MS = L5_MAX_DAYS * 86_400_000;

export interface Requirement {
  action_class: ActionClass;
  risk: RiskTier;
  decision: "auto" | "needs_approval" | "forbidden";
  approvers: Approver[];
  two_key: boolean;
  step_up: boolean;
  reason?: string;
}

const isAutoCell = (cell: MatrixCell) => !!cell.approvers && cell.approvers.length === 1 && cell.approvers[0] === "auto";

/**
 * What it takes for an agent at `level` to perform `cls` at `risk`.
 *  - Two-key classes are never auto (not even L5).
 *  - An auto cell needs owner approval when the agent's level is below the class minimum.
 *  - A risk above the level's reach routes only to the owner (plus the cell's approvers).
 *  - L5 inside its owner-signed contract makes non-two-key approvals auto.
 */
export function requiredApprovals(cls: ActionClass, risk: RiskTier, level: AutonomyLevel = "L0", opts: { inL5Contract?: boolean } = {}): Requirement {
  const cell = APPROVAL_MATRIX[cls]?.[risk];
  const base = { action_class: cls, risk };
  if (!cell || !cell.approvers)
    return { ...base, decision: "forbidden", approvers: [], two_key: false, step_up: false, reason: cls === "core_change" ? "core changes are owner code + deploy only" : "not a valid action at this risk tier" };
  if (TWO_KEY_CLASSES.includes(cls) || cell.two_key) return { ...base, decision: "needs_approval", approvers: [...cell.approvers], two_key: true, step_up: cell.step_up, reason: "two-key class" };
  if (isAutoCell(cell)) {
    const min = AUTO_MIN_LEVEL[cls] ?? "L0";
    if (levelNum(level) >= levelNum(min)) return { ...base, decision: "auto", approvers: ["auto"], two_key: false, step_up: false };
    return { ...base, decision: "needs_approval", approvers: ["owner"], two_key: false, step_up: false, reason: `${level} is below ${min} for ${cls}` };
  }
  if (opts.inL5Contract && level === "L5") return { ...base, decision: "auto", approvers: ["auto"], two_key: false, step_up: false, reason: "covered by the owner-signed L5 contract" };
  const rung = AUTONOMY_LADDER[levelNum(level)];
  if (risk > rung.max_risk)
    return { ...base, decision: "needs_approval", approvers: [...new Set<Approver>([...cell.approvers, "owner"])].filter((a) => a !== "auto"), two_key: false, step_up: risk >= 4, reason: `risk R${risk} is above ${level}'s reach (R${rung.max_risk}); owner must sign` };
  return { ...base, decision: "needs_approval", approvers: [...cell.approvers], two_key: false, step_up: cell.step_up };
}

export interface ApprovalKey {
  approver: Exclude<Approver, "auto">;
  /** Who turned the key: "owner" for the owner; agent / court / council member id otherwise. */
  by: string;
  /** Division of the key holder; must differ from the requester's for the second key. */
  division?: string | null;
  step_up?: boolean;
  at?: number;
}

export interface ApprovalCheck {
  satisfied: boolean;
  missing: string[];
}

/**
 * Do the collected keys satisfy the requirement?
 *  - forbidden → never; auto → always.
 *  - two-key: an owner key (fresh TOTP when step_up) AND one more key from a listed non-owner approver, turned by
 *    someone other than the requester and the owner, outside the requester's division.
 *  - otherwise: one key from a listed approver (the owner may stand in for any), not turned by the requester; when
 *    the requirement names the owner explicitly (reason "owner must sign"), only the owner key counts.
 */
export function checkApprovals(req: Requirement, keys: ApprovalKey[], requester: { id: string; division?: string | null } = { id: "" }): ApprovalCheck {
  if (req.decision === "forbidden") return { satisfied: false, missing: [req.reason ?? "forbidden"] };
  if (req.decision === "auto") return { satisfied: true, missing: [] };
  const missing: string[] = [];
  const ownerKey = keys.find((k) => k.approver === "owner" && k.by === "owner");
  if (req.two_key) {
    if (!ownerKey) missing.push("owner key");
    else if (req.step_up && !ownerKey.step_up) missing.push("owner step-up (TOTP)");
    const seconds = req.approvers.filter((a) => a !== "owner");
    const second = keys.find(
      (k) => k.approver !== "owner" && seconds.includes(k.approver) && k.by !== requester.id && k.by !== "owner" && (!requester.division || !k.division || k.division !== requester.division),
    );
    if (!second) missing.push(`second key (${seconds.join(" | ")}, different division from the requester)`);
    return { satisfied: missing.length === 0, missing };
  }
  const ownerOnly = req.approvers.length === 1 && req.approvers[0] === "owner";
  const mustOwner = ownerOnly || (req.reason ?? "").includes("owner must sign");
  if (mustOwner) {
    if (!ownerKey) missing.push("owner key");
    else if (req.step_up && !ownerKey.step_up) missing.push("owner step-up (TOTP)");
    return { satisfied: missing.length === 0, missing };
  }
  const ok = keys.some((k) => (req.approvers.includes(k.approver) || (k.approver === "owner" && k.by === "owner")) && k.by !== requester.id && (!req.step_up || k.approver !== "owner" || k.step_up));
  if (!ok) missing.push(`one key from ${req.approvers.join(" | ")}`);
  return { satisfied: ok, missing };
}

/** Full matrix as a plain table (for the API / console). */
export function matrixTable() {
  return ACTION_CLASSES.map((cls) => ({
    action_class: cls,
    two_key: TWO_KEY_CLASSES.includes(cls),
    cells: RISK_TIERS.map((r) => {
      const cell = APPROVAL_MATRIX[cls][r];
      return { risk: r, approvers: cell.approvers, two_key: cell.two_key, step_up: cell.step_up, note: cell.note ?? null };
    }),
  }));
}
