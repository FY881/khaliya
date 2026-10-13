/**
 * THE CONSTITUTION — immutable rules of the organization.
 *
 * This module is NOT part of the evolvable set. Agents have no tool that can read-modify-write it,
 * genomes cannot reference it, and every value is deep-frozen at load time. Changing it requires a
 * code change + redeploy by the owner.
 */

export type Tier = 0 | 1 | 2 | 3 | 4;
export type Role =
  | "director"
  | "architect"
  | "researcher"
  | "builder"
  | "toolsmith"
  | "evaluator"
  | "critic"
  | "librarian"
  | "auditor";

export type AgentStatus = "draft" | "sandboxed" | "candidate" | "champion" | "retired" | "quarantined";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o as object).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

export const CONSTITUTION = deepFreeze({
  version: 1,
  articles: [
    "1. The owner (Omar) is the only human authority. There is no signup and no other admin.",
    "2. Every T3 (external read) and T4 (external write / spend / publish) action requires the owner's explicit approval.",
    "3. No action may spend money. Only free-tier providers and free models may be called.",
    "4. The Governor, this constitution, the audit log and the approval queue are outside the evolvable set.",
    "5. Every run obeys hard caps on steps, tokens, tool calls, LLM calls and wall time.",
    "6. No agent evaluates, approves or promotes its own candidate. Evaluator, Critic and Auditor lineages are protected.",
    "7. Every action is written to the append-only audit log.",
    "8. The owner can stop everything at once (global kill switch) or any single agent.",
  ],
  tiers: {
    0: "think / own memory",
    1: "internal org tools",
    2: "sandboxed code",
    3: "external read (approval)",
    4: "external write / spend / publish (approval + step-up)",
  } as Record<Tier, string>,
  /** Tiers that always route to the owner's approval queue. */
  approvalTiers: [3, 4] as Tier[],
  /** T4 approvals additionally need a fresh TOTP code (step-up). */
  stepUpTiers: [4] as Tier[],
  /** Highest tool tier each role may even request. */
  roleMaxTier: {
    director: 4,
    architect: 1,
    researcher: 3,
    builder: 2,
    toolsmith: 2,
    evaluator: 2,
    critic: 1,
    librarian: 1,
    auditor: 1,
  } as Record<Role, Tier>,
  protectedRoles: ["evaluator", "critic", "auditor"] as Role[],
  /** Absolute per-run ceilings. A genome's budget_profile can only lower these. */
  runHardCaps: { max_steps: 12, max_tokens: 24000, max_tool_calls: 8, max_llm_calls: 16, max_wall_ms: 90_000 },
  /** Defaults used when a genome asks for nothing specific. */
  runDefaultCaps: { max_steps: 6, max_tokens: 12000, max_tool_calls: 5, max_llm_calls: 10, max_wall_ms: 60_000 },
  genomeLimits: { system_prompt_chars: 8000, tool_ids: 24, skills: 24, eval_suites: 16, mutation_log: 200, body_bytes: 32_000 },
  /** Prefixes a genome may never reference (tools or skills). */
  forbiddenCapabilityPrefixes: ["governor.", "constitution.", "audit.", "approval.", "auth.", "budget.", "kill."],
  /** Model id must start with one of these. OpenRouter models must end with ":free". */
  allowedModelProviders: ["gemini:", "openrouter:", "workers-ai:", "mock:"],
  populationCap: { live: 24, candidates: 12 },
  quotaMargin: 0.7,
});

export const ROLES = Object.keys(CONSTITUTION.roleMaxTier) as Role[];
export const STATUSES: AgentStatus[] = ["draft", "sandboxed", "candidate", "champion", "retired", "quarantined"];

/** Lifecycle: draft → sandboxed → candidate → champion → retired (+ quarantined from any live state). */
export const LIFECYCLE: Record<AgentStatus, AgentStatus[]> = deepFreeze({
  draft: ["sandboxed", "retired", "quarantined"],
  sandboxed: ["candidate", "draft", "retired", "quarantined"],
  candidate: ["champion", "sandboxed", "retired", "quarantined"],
  champion: ["retired", "quarantined", "candidate"],
  quarantined: ["sandboxed", "retired"],
  retired: [],
});

/** Statuses that may execute runs. Sandboxed runs get fake tools for T2+ and no external effects. */
export const RUNNABLE: AgentStatus[] = ["sandboxed", "candidate", "champion"];

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return LIFECYCLE[from]?.includes(to) ?? false;
}
