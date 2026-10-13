import type { Env } from "../env";
import type { Role } from "../constitution";
import type { GenomeInput, PlanningStrategy } from "../genome/schema";
import { audit } from "../audit";
import { TOOLS } from "../tools/catalog";
import { Registry } from "./registry";

const FREE_PRIMARY = "gemini:gemini-flash-lite-latest";
const FREE_FALLBACKS = ["openrouter:meta-llama/llama-3.3-70b-instruct:free", "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

interface Seed {
  role: Role;
  name: string;
  name_ar: string;
  strategy: PlanningStrategy;
  tools: string[];
  prompt: string;
  temperature?: number;
}

/** Starter organization (P1). All start as champions of their own lineage, version 1. */
export const STARTER_ORG: Seed[] = [
  {
    role: "director",
    name: "Director",
    name_ar: "المدير",
    strategy: "plan-execute",
    tools: ["think", "memory.write", "memory.search", "org.list_agents", "org.message"],
    prompt:
      "You are the Director, Omar's proxy. Turn the owner's goals into clear objectives, decide which agent should do what, and send them concise briefs. Escalate anything external, risky or costly to the owner. Never spend money.",
  },
  {
    role: "architect",
    name: "Architect",
    name_ar: "المعماري",
    strategy: "tree-of-thought",
    tools: ["think", "memory.write", "memory.search", "org.list_agents"],
    prompt:
      "You are the Architect. Design new agent roles and propose improvements to existing genomes (prompt rewrites, strategy swaps, tool changes). Every proposal must state the expected benefit, the risk, and how it will be evaluated.",
  },
  {
    role: "researcher",
    name: "Researcher",
    name_ar: "الباحث",
    strategy: "react",
    tools: ["think", "memory.write", "memory.search", "org.message", "http.get"],
    prompt:
      "You are the Researcher. Gather knowledge and write compact, sourced findings. Reading the external web requires the owner's approval via http.get; prefer what you already know and say how confident you are.",
  },
  {
    role: "builder",
    name: "Builder",
    name_ar: "البنّاء",
    strategy: "plan-execute",
    tools: ["think", "memory.write", "memory.search", "sandbox.eval"],
    prompt:
      "You are the Builder. Solve concrete tasks step by step, write correct and minimal solutions, and verify your work in the sandbox before claiming it is done.",
    temperature: 0.2,
  },
  {
    role: "evaluator",
    name: "Evaluator",
    name_ar: "المُقيِّم",
    strategy: "plan-execute",
    tools: ["think", "memory.write", "memory.search", "sandbox.eval", "eval.author", "eval.list_public"],
    prompt:
      "You are the Evaluator. Write tests that are solvable, discriminative and hard to game. Judge outputs against explicit criteria; never evaluate your own lineage's work.",
    temperature: 0.1,
  },
  {
    role: "critic",
    name: "Critic",
    name_ar: "الناقد",
    strategy: "reflexion",
    tools: ["think", "memory.write", "memory.search", "eval.list_public"],
    prompt:
      "You are the Critic and red-team. Review proposals, plans and tools for flaws, safety risks and cost. Be specific: name the failure mode, its likelihood and a fix.",
    temperature: 0.2,
  },
  {
    role: "librarian",
    name: "Librarian",
    name_ar: "أمين المكتبة",
    strategy: "react",
    tools: ["think", "memory.write", "memory.search", "org.list_agents"],
    prompt:
      "You are the Librarian. Curate knowledge: deduplicate, summarize, tag and prune. Keep entries short, sourced and dated, and flag low-confidence claims for the Critic.",
  },
  {
    role: "auditor",
    name: "Auditor",
    name_ar: "المُدقِّق",
    strategy: "reflexion",
    tools: ["think", "memory.write", "memory.search", "org.list_agents"],
    prompt:
      "You are the Auditor. Watch budgets, anomalies and rule compliance. Report spend spikes, loops and repeated failures plainly, and recommend pausing agents when needed.",
    temperature: 0.1,
  },
];

export function starterGenome(s: Seed): GenomeInput {
  return {
    lineage_id: s.role,
    parent_ids: [],
    version: 1,
    role: s.role,
    name: s.name,
    system_prompt: s.prompt,
    planning_strategy: s.strategy,
    model_policy: { primary: FREE_PRIMARY, fallbacks: FREE_FALLBACKS, temperature: s.temperature ?? 0.3 },
    tool_ids: s.tools,
    memory_policy: { working_k: 6, episodic_retention_days: 30, write_lessons: true },
    skills: [],
    eval_suites: [`${s.role}-basic`],
    budget_profile: {},
    mutation_log: [{ op: "seed", note: `starter ${s.name} (${s.name_ar})`, at: 0, by: "system" }],
    created_by: "system:seed",
  };
}

export async function seedTools(env: Env): Promise<void> {
  const stmt = env.DB.prepare(
    "INSERT INTO tools (id, name, tier, description, schema, version, status, builtin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 'active', 1, ?6) ON CONFLICT(id) DO UPDATE SET name = excluded.name, tier = excluded.tier, description = excluded.description, schema = excluded.schema",
  );
  await env.DB.batch(TOOLS.map((t) => stmt.bind(t.id, t.name, t.tier, t.description, JSON.stringify(t.schema), Date.now())));
}

/** Idempotent: creates missing starter genomes/agents only. */
export async function seedStarterOrg(env: Env, actor = "owner"): Promise<{ created: string[]; existing: string[] }> {
  await seedTools(env);
  const reg = new Registry(env);
  const created: string[] = [];
  const existing: string[] = [];
  for (const s of STARTER_ORG) {
    const id = `a_${s.role}`;
    if (await reg.getAgent(id)) {
      existing.push(id);
      continue;
    }
    const g = await reg.putGenome({ ...starterGenome(s), created_at: Date.now() }, "system:seed");
    await reg.createAgent(g, { id, status: "champion", actor });
    created.push(id);
  }
  await audit(env.DB, actor, "org.seed", null, { created, existing });
  return { created, existing };
}
