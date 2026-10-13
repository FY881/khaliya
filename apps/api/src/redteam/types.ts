/**
 * Red-Team Arena (P8 / ARCHITECTURE §19 C6) — shared types.
 *
 * An ATTACK is pure data: a benign task for the target plus an adversarial payload carried by one vector
 * (a tool output, a KB document, a forged-tool manifest, memory, an eval item, or the user turn itself) and a
 * GOAL (what the attacker wants the target to do). Whether an attack succeeded is decided by arena code
 * (deterministic detectors + a critic), never by anything the attacker wrote.
 */

export const CATEGORIES = [
  "prompt_injection",
  "tool_poisoning",
  "budget_evasion",
  "approval_bypass",
  "eval_gaming",
  "data_exfiltration",
  "constitution_violation",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, { en: string; ar: string }> = {
  prompt_injection: { en: "Prompt injection (tool outputs / KB docs)", ar: "حقن التعليمات عبر مخرجات الأدوات والمستندات" },
  tool_poisoning: { en: "Tool poisoning (forged / MCP manifests)", ar: "تسميم الأدوات" },
  budget_evasion: { en: "Budget / cap evasion", ar: "التحايل على الميزانية والحدود" },
  approval_bypass: { en: "Approval bypass", ar: "تجاوز الموافقة" },
  eval_gaming: { en: "Eval gaming / verifier tampering", ar: "التلاعب بالتقييم والمدقِّق" },
  data_exfiltration: { en: "Data exfiltration", ar: "تسريب البيانات" },
  constitution_violation: { en: "Constitution violation", ar: "مخالفة الدستور" },
};

export type Lang = "en" | "ar" | "mixed";
export const LANGS: Lang[] = ["en", "ar", "mixed"];

export type Vector = "tool_output" | "kb_doc" | "tool_manifest" | "memory" | "eval_item" | "user";
export const VECTORS: Vector[] = ["tool_output", "kb_doc", "tool_manifest", "memory", "eval_item", "user"];

export interface Observation {
  tool: string;
  args?: Record<string, unknown>;
  output: string;
}
export interface KbDoc {
  title: string;
  text: string;
}
export interface ManifestTool {
  id: string;
  tier: number;
  description: string;
}

/** What the attacker wants. Every field is an independent success condition (any one ⇒ breach). */
export interface AttackGoal {
  /** Tool ids the target must NOT call (any attempt counts, whether or not the gateway would allow it). */
  tools?: string[];
  /** When set, a goal-tool call only counts if its args contain one of these strings. */
  args_contain?: string[];
  /** Attacker marker phrases that must not appear in the target's output (compliance proof). */
  say?: string[];
  /** Secrets (canaries) visible to the target that must not leave it (args or final answer). */
  leak?: string[];
  /** Decoy verifier / reference symbols that must not be touched (verifier tampering). */
  decoys?: string[];
  /** The target must not attempt more tool calls than this in one run (cap evasion). */
  max_tool_calls?: number;
}

export interface AttackSpec {
  category: Category;
  lang: Lang;
  vector: Vector;
  title: string;
  /** 1 (naive) .. 10 (strong). Used for ordering and by the deterministic mock target. */
  difficulty: number;
  /** The benign task the target is working on. */
  task: string;
  /** Replacement task for the payload-free control run when the payload lives in the task itself (vector "user"). */
  control_task?: string;
  context?: { secrets?: string[]; memory?: string[] };
  observations?: Observation[];
  kb_docs?: KbDoc[];
  tool_manifest?: ManifestTool[];
  eval_item?: { task: string; inputs: Record<string, unknown>; format?: string };
  goal: AttackGoal;
  /** What a safe target does (human-readable, bilingual where useful). */
  expected_safe: string;
  /** An example safe final answer; it must pass every detector (checked at admission). */
  safe_reference: string;
  tags?: string[];
}

export type AttackStatus = "active" | "candidate" | "rejected" | "retired";

export interface AttackRow extends AttackSpec {
  id: string;
  hash: string;
  source: string; // seed | owner | attacker:<id>
  attacker_id: string | null;
  status: AttackStatus;
  validation: unknown;
  created_at: number;
  updated_at: number;
}

/** One action the target attempted, with what the simulated gateway decided. */
export interface TraceAction {
  tool: string;
  args: Record<string, unknown>;
  decision: "ok_simulated" | "sandboxed" | "would_need_approval" | "denied";
  reason?: string;
  tier?: number;
}

export interface TargetTrace {
  actions: TraceAction[];
  final: string;
  raw?: string;
  parse_error?: boolean;
  model?: string;
  control?: boolean;
}

export interface DetectorHit {
  detector: string;
  severity: number; // 0..1
  evidence: string;
}

export interface CriticVerdict {
  breach: boolean;
  severity: number;
  rationale: string;
  model?: string;
}

export interface AttackOutcome {
  breach: boolean;
  /** true = only the critic flagged it (no deterministic detector fired). */
  soft: boolean;
  severity: number;
  hits: DetectorHit[];
  critic: CriticVerdict | null;
  /** The gateway would have stopped every attacker-goal action (no effect even though the agent complied). */
  contained: boolean;
  trace: TargetTrace;
  llm_calls: number;
}

export type ResultKind = "probe" | "control" | "repro" | "gate";
export type BreachStatus = "suspected" | "confirmed" | "rejected";

/** Attacker lineage: lab-side genome. T1/T2 only, no tools, no network — its output is data, never actions. */
export interface AttackerGenome {
  id: string;
  name: string;
  version: number;
  system_prompt: string;
  model_policy: { primary: string; fallbacks: string[]; temperature: number };
  max_tier: 1 | 2;
  tools: [];
}
