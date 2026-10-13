// Static (no-LLM, no-run) admission checks for an evolved candidate genome, plus the
// self-evaluation guard. Constitution article 6: no agent evaluates, approves or promotes its own
// candidate, and the Evaluator / Critic / Auditor lineages are protected.
import { CONSTITUTION, ROLES, type Role } from "../constitution";
import { validateGenome, type Genome, type GenomeInput } from "../genome/schema";
import { TOOL_MAP } from "../tools/catalog";
import { jaccard, similarity } from "../eval/text";

export interface CheckContext {
  /** Genomes already in the population/archive (the candidate itself is ignored if present). */
  existing: (Genome | GenomeInput)[];
  /** The parent the candidate claims to derive from (first parent for crossovers). */
  parent?: Genome | null;
  /** Role of the agent proposing the candidate. */
  proposerRole?: Role | "owner";
  /** Agent / lineage ids of the proposer. */
  proposerAgentId?: string;
  proposerLineageId?: string;
  /**
   * Agent ids / lineage ids currently judged by the candidate's (protected) lineage. Such agents
   * may never propose changes to the lineage that judges them.
   */
  judgedIds?: string[];
  minNovelty?: number; // default 0.05
  maxPromptChars?: number; // default constitution limit
  maxTools?: number; // default constitution limit
}

export interface CheckResult {
  pass: boolean;
  reasons: string[];
  novelty: number; // 0 = identical to some existing genome, 1 = nothing comparable
  nearestId?: string;
}

export const MIN_NOVELTY = 0.05;

/** Field weights for the genome distance (sum = 1). */
export const NOVELTY_WEIGHTS = {
  system_prompt: 0.4,
  planning_strategy: 0.1,
  model_policy: 0.15,
  tool_ids: 0.15,
  memory_policy: 0.05,
  skills: 0.05,
  eval_suites: 0.05,
  budget_profile: 0.05,
} as const;

const setDist = (a: string[] = [], b: string[] = []) => 1 - jaccard(new Set(a), new Set(b));
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** Field-weighted distance in [0, 1] between two genomes' evolvable content. */
export function genomeDistance(a: Genome | GenomeInput, b: Genome | GenomeInput): number {
  const W = NOVELTY_WEIGHTS;
  const ma = a.model_policy ?? ({} as Genome["model_policy"]);
  const mb = b.model_policy ?? ({} as Genome["model_policy"]);
  const model =
    0.5 * (ma.primary === mb.primary ? 0 : 1) +
    0.3 * setDist(ma.fallbacks, mb.fallbacks) +
    0.2 * Math.min(1, Math.abs((ma.temperature ?? 0) - (mb.temperature ?? 0)) / 1);
  const pa = a.memory_policy ?? ({} as Genome["memory_policy"]);
  const pb = b.memory_policy ?? ({} as Genome["memory_policy"]);
  const mem =
    (Math.min(1, Math.abs((pa.working_k ?? 0) - (pb.working_k ?? 0)) / 8) +
      Math.min(1, Math.abs((pa.episodic_retention_days ?? 0) - (pb.episodic_retention_days ?? 0)) / 60) +
      (pa.write_lessons === pb.write_lessons ? 0 : 1)) /
    3;
  const d =
    W.system_prompt * (1 - similarity(a.system_prompt ?? "", b.system_prompt ?? "")) +
    W.planning_strategy * (a.planning_strategy === b.planning_strategy ? 0 : 1) +
    W.model_policy * model +
    W.tool_ids * setDist(a.tool_ids, b.tool_ids) +
    W.memory_policy * mem +
    W.skills * setDist(a.skills, b.skills) +
    W.eval_suites * setDist(a.eval_suites, b.eval_suites) +
    W.budget_profile * (same(a.budget_profile ?? {}, b.budget_profile ?? {}) ? 0 : 1);
  return Math.max(0, Math.min(1, d));
}

/** Novelty = distance to the nearest existing genome (1 when there is nothing to compare). */
export function novelty(candidate: Genome | GenomeInput, existing: (Genome | GenomeInput)[]): { novelty: number; nearestId?: string } {
  let best = 1;
  let nearestId: string | undefined;
  for (const g of existing) {
    if (candidate.id && g.id === candidate.id) continue;
    const d = genomeDistance(candidate, g);
    if (d < best || (nearestId === undefined && d <= best)) {
      best = d;
      nearestId = g.id;
    }
  }
  return { novelty: best, nearestId };
}

export const isProtectedRole = (role: string): boolean => (CONSTITUTION.protectedRoles as string[]).includes(role);

/** A lineage is protected when it carries a protected role (or is named after one). */
export function isProtectedLineage(g: Pick<Genome, "role" | "lineage_id">): boolean {
  return isProtectedRole(g.role) || isProtectedRole(g.lineage_id);
}

function protectedRoleOf(g: Pick<Genome, "role" | "lineage_id">): Role | undefined {
  if (isProtectedRole(g.role)) return g.role;
  if (isProtectedRole(g.lineage_id)) return g.lineage_id as Role;
  return undefined;
}

export function staticChecks(candidate: Genome | GenomeInput, ctx: CheckContext): CheckResult {
  const reasons: string[] = [];
  const L = CONSTITUTION.genomeLimits;
  const maxPrompt = Math.min(ctx.maxPromptChars ?? L.system_prompt_chars, L.system_prompt_chars);
  const maxTools = Math.min(ctx.maxTools ?? L.tool_ids, L.tool_ids);

  // 1. schema
  const v = validateGenome(candidate);
  for (const e of v.errors) reasons.push(`schema: ${e}`);
  const c = candidate as Genome;
  const role: Role | undefined = ROLES.includes(c.role) ? c.role : undefined;

  // 2. tools / skills: forbidden prefixes, unknown tools, tier ceiling
  const tools = Array.isArray(c.tool_ids) ? c.tool_ids : [];
  const skills = Array.isArray(c.skills) ? c.skills : [];
  for (const ref of [...tools, ...skills]) {
    if (CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => String(ref).startsWith(p))) reasons.push(`forbidden: '${ref}'`);
  }
  for (const t of tools) {
    const def = TOOL_MAP[t] ?? (String(t).startsWith("forge.") ? { tier: 1 } : undefined); // forged tools are T1 (gateway checks admission)
    if (!def) {
      if (!CONSTITUTION.forbiddenCapabilityPrefixes.some((p) => String(t).startsWith(p))) reasons.push(`tools: unknown tool '${t}'`);
      continue;
    }
    if (role && def.tier > CONSTITUTION.roleMaxTier[role])
      reasons.push(`tier: '${t}' is T${def.tier}, above ${role} ceiling T${CONSTITUTION.roleMaxTier[role]}`);
  }

  // 3. size limits
  if (typeof c.system_prompt === "string" && c.system_prompt.length > maxPrompt)
    reasons.push(`size: system_prompt ${c.system_prompt.length} > ${maxPrompt} chars`);
  if (tools.length > maxTools) reasons.push(`size: ${tools.length} tools > ${maxTools}`);

  // 4. lineage consistency with the parent
  const p = ctx.parent;
  if (p) {
    if (!Array.isArray(c.parent_ids) || !c.parent_ids.includes(p.id)) reasons.push("lineage: candidate does not list the parent");
    const newLineage = c.version === 1 && c.lineage_id !== p.lineage_id;
    if (!newLineage) {
      if (c.lineage_id !== p.lineage_id) reasons.push(`lineage: '${c.lineage_id}' differs from parent '${p.lineage_id}'`);
      if (c.role !== p.role) reasons.push(`lineage: role change ${p.role}→${c.role} within a lineage`);
      if (!(c.version > p.version)) reasons.push(`lineage: version ${c.version} must exceed parent ${p.version}`);
    }
  }
  if (c.version === 1 && ctx.existing.some((g) => g.lineage_id === c.lineage_id && g.id !== c.id))
    reasons.push(`lineage: '${c.lineage_id}' already exists (version 1 must start a new lineage)`);

  // 5. protected lineages (article 6)
  if (role) {
    const prot = protectedRoleOf(c);
    if (prot) {
      if (ctx.proposerRole === prot) reasons.push(`protected: a ${prot} may not propose ${prot} lineage genomes`);
      if (ctx.proposerLineageId && ctx.proposerLineageId === c.lineage_id)
        reasons.push(`protected: lineage '${c.lineage_id}' may not propose its own successor`);
      const judged = new Set(ctx.judgedIds ?? []);
      if ((ctx.proposerAgentId && judged.has(ctx.proposerAgentId)) || (ctx.proposerLineageId && judged.has(ctx.proposerLineageId)))
        reasons.push(`protected: the proposer is judged by ${prot} and may not modify it`);
    }
  }

  // 6. novelty
  const n = novelty(candidate, ctx.existing);
  const minN = ctx.minNovelty ?? MIN_NOVELTY;
  if (n.novelty < minN) reasons.push(`novelty: ${n.novelty.toFixed(3)} < ${minN} (near-duplicate of ${n.nearestId})`);

  return { pass: reasons.length === 0, reasons, novelty: n.novelty, nearestId: n.nearestId };
}

export interface JudgeIdentity {
  id: string; // agent id
  lineage_id: string;
  genome_id?: string;
}

/** Why `judge` may not evaluate `candidate` (empty = allowed). */
export function judgeConflicts(judge: JudgeIdentity, candidate: Pick<Genome, "id" | "lineage_id" | "parent_ids" | "created_by">): string[] {
  const out: string[] = [];
  if (judge.genome_id && judge.genome_id === candidate.id) out.push("judge runs the candidate genome");
  if (judge.lineage_id === candidate.lineage_id) out.push("judge belongs to the candidate's lineage");
  if (judge.genome_id && candidate.parent_ids?.includes(judge.genome_id)) out.push("judge's genome is a parent of the candidate");
  const by = candidate.created_by ?? "";
  if (by === judge.id || by === `agent:${judge.id}` || by === judge.lineage_id || by === `lineage:${judge.lineage_id}`)
    out.push("judge authored the candidate");
  return out;
}

/** Self-evaluation guard: true only when the judge is independent of the candidate. */
export function canJudge(judge: JudgeIdentity, candidate: Pick<Genome, "id" | "lineage_id" | "parent_ids" | "created_by">): boolean {
  return judgeConflicts(judge, candidate).length === 0;
}
