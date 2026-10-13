import type { Tier } from "../constitution";
import { home } from "../home/stub";
import type { Env } from "../env";
import { LabLLM } from "../eval/llm";
import { getSuite, listPublicItems } from "../eval/store";
import { SPLITS, type ItemSpec } from "../eval/types";
import { validateItem } from "../eval/validate";
import { forgeSubmitTool } from "../forge/agentTool";
import { kbSearchTool, kbWriteTool } from "../memory/tools";

export interface MemoryStore {
  write(kind: string, text: string, meta?: Record<string, unknown>): Promise<{ id: number }>;
  search(query: string, k: number): Promise<{ id: number; kind: string; text: string; score: number; at: number }[]>;
}

export interface ToolContext {
  env: Env;
  agentId: string;
  runId?: string;
  role: string;
  /** Lineage of the calling agent's genome (set by AgentHome; looked up when absent). */
  lineage?: string;
  memory?: MemoryStore;
  sandboxed: boolean;
  approved?: boolean; // true only when executed from an owner-approved request
}

export interface ToolDef {
  id: string;
  name: string;
  tier: Tier;
  description: string;
  schema: { required?: string[]; properties: Record<string, { type: string; description?: string }> };
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;
  /** Route to the owner's approval queue even below T3 (e.g. forge.submit). Sandboxed agents get a simulated result. */
  requiresApproval?: boolean;
  /**
   * Runs before an approval row is created: validates/stages the request and returns the (compact) args to store.
   * Throw to deny with invalid_args. Return `immediate` to answer at once without an approval (e.g. a duplicate).
   */
  prepareApproval?: (ctx: ToolContext, args: Record<string, any>) => Promise<{ args?: Record<string, unknown>; reason?: string; immediate?: unknown }>;
  /** Called when the owner rejects this tool's approval (clean up staged state). Must not throw. */
  onReject?: (env: Env, args: Record<string, any>) => Promise<void>;
}

// ---- tiny safe arithmetic evaluator for the T2 sandbox stub (real WASM sandbox lands in P4) ----
function evalArithmetic(src: string): number {
  if (src.length > 200 || !/^[\d\s+\-*/().%]+$/.test(src)) throw new Error("only arithmetic expressions are allowed");
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === " ") i++;
  };
  const num = (): number => {
    skip();
    if (peek() === "(") {
      i++;
      const v = expr();
      skip();
      if (src[i++] !== ")") throw new Error("missing )");
      return v;
    }
    if (peek() === "-") {
      i++;
      return -num();
    }
    const m = src.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error("number expected");
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number => {
    let v = num();
    for (;;) {
      skip();
      const c = peek();
      if (c === "*" || c === "/" || c === "%") {
        i++;
        const r = num();
        v = c === "*" ? v * r : c === "/" ? v / r : v % r;
      } else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      skip();
      const c = peek();
      if (c === "+" || c === "-") {
        i++;
        const r = term();
        v = c === "+" ? v + r : v - r;
      } else return v;
    }
  };
  const v = expr();
  skip();
  if (i !== src.length) throw new Error("unexpected input");
  return v;
}

// ---- eval factory tools ----
/** Share of the org's daily free LLM calls the lab may use; per-call ceiling for one authored item's validation. */
const EVAL_AUTHOR_LAB = { maxCalls: 80, share: 0.3 };
const AUTHOR_SPLITS = ["public", "private"];
/** Item ids in gate reasons would let an author probe which (private) items exist: redact them. */
const redactIds = (s?: string) => (s ? s.replace(/\bei_[a-f0-9]{6,}\b/g, "ei_…") : s);

export async function callerLineage(c: ToolContext): Promise<string | null> {
  if (c.lineage) return c.lineage;
  const r = await c.env.DB.prepare("SELECT g.lineage_id AS l FROM agents a JOIN genomes g ON g.id = a.genome_id WHERE a.id = ?1")
    .bind(c.agentId)
    .first<{ l: string }>()
    .catch(() => null);
  return r?.l ?? null;
}

async function evalAuthor(c: ToolContext, a: Record<string, any>) {
  const suiteId = String(a.suite_id ?? a.suite ?? "");
  if (!suiteId) throw new Error("suite_id required");
  if (!(await getSuite(c.env, suiteId))) throw new Error(`unknown suite '${suiteId}'`);
  const split = String(a.split ?? "private");
  if (!AUTHOR_SPLITS.includes(split) || !SPLITS.includes(split as ItemSpec["split"])) throw new Error("split: 'public' or 'private'");
  let inputs = a.inputs ?? {};
  if (typeof inputs === "string") {
    try {
      inputs = JSON.parse(inputs);
    } catch {
      throw new Error("inputs: object");
    }
  }
  let checker = a.checker;
  if (typeof checker === "string") {
    try {
      checker = JSON.parse(checker);
    } catch {
      throw new Error("checker: object");
    }
  }
  const spec: ItemSpec = {
    suite_id: suiteId,
    task: typeof a.task === "string" ? a.task : "",
    inputs,
    checker,
    reference: typeof a.reference === "string" ? a.reference : a.reference == null ? "" : String(a.reference),
    difficulty: Number(a.difficulty ?? 5),
    tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 12) : [],
    split: split as ItemSpec["split"],
  };
  const lineage = await callerLineage(c);
  const lab = new LabLLM(c.env, EVAL_AUTHOR_LAB);
  // Sandboxed agents rehearse: the item is validated but never stored.
  const v = await validateItem(c.env, lab, spec, { author: `agent:${c.agentId}`, author_lineage: lineage, persist: !c.sandboxed });
  const reasons = v.gates.filter((g) => !g.pass || g.reason).map((g) => `${g.gate}: ${redactIds(g.reason) ?? (g.pass ? "ok" : "failed")}`);
  return {
    status: v.status,
    validated: v.validated,
    quality: v.quality,
    reason: redactIds(v.reason),
    reasons,
    gates: v.gates.map((g) => ({ gate: g.gate, pass: g.pass })),
    item_id: v.item ? v.item.id : null,
    stored: !!v.item,
    duplicate: !!v.duplicate_of,
    sandboxed: c.sandboxed,
    llm_calls: lab.calls,
  };
}

const P1_NO_EFFECT = "Approved by owner and recorded. External effects for this tool are not enabled in P1, so nothing was sent/spent/published.";

export const TOOLS: ToolDef[] = [
  {
    id: "think",
    name: "Think",
    tier: 0,
    description: "Write a private scratch thought. No side effects.",
    schema: { required: ["note"], properties: { note: { type: "string" } } },
    handler: async (_c, a) => ({ noted: String(a.note).slice(0, 500) }),
  },
  {
    id: "memory.write",
    name: "Write memory",
    tier: 0,
    description: "Store a fact, note or lesson in your own long-term memory.",
    schema: { required: ["text"], properties: { text: { type: "string" }, kind: { type: "string" } } },
    handler: async (c, a) => {
      if (!c.memory) throw new Error("memory unavailable");
      return c.memory.write(String(a.kind ?? "note"), String(a.text).slice(0, 2000), { run: c.runId });
    },
  },
  {
    id: "memory.search",
    name: "Search memory",
    tier: 0,
    description: "Search your own memory by keywords.",
    schema: { required: ["query"], properties: { query: { type: "string" }, k: { type: "number" } } },
    handler: async (c, a) => {
      if (!c.memory) throw new Error("memory unavailable");
      return c.memory.search(String(a.query), Math.min(Number(a.k ?? 5), 10));
    },
  },
  {
    id: "org.list_agents",
    name: "List agents",
    tier: 1,
    description: "List live agents in the organization (id, role, status).",
    schema: { properties: {} },
    handler: async (c) =>
      (await c.env.DB.prepare("SELECT id, name, role, status FROM agents WHERE status != 'retired' ORDER BY role").all()).results,
  },
  {
    id: "org.message",
    name: "Message agent",
    tier: 1,
    description: "Send a message to another agent's inbox.",
    schema: { required: ["to", "text"], properties: { to: { type: "string" }, text: { type: "string" } } },
    handler: async (c, a) => {
      const to = String(a.to);
      const exists = await c.env.DB.prepare("SELECT id FROM agents WHERE id = ?1 AND status != 'retired'").bind(to).first();
      if (!exists) throw new Error(`unknown agent '${to}'`);
      if (c.sandboxed) return { delivered: false, sandboxed: true };
      const stub = home(c.env, to);
      await stub.deliver(c.agentId, String(a.text).slice(0, 2000));
      return { delivered: true, to };
    },
  },
  {
    id: "eval.author",
    name: "Author eval item",
    tier: 1,
    description:
      "Submit a NEW eval item (task, inputs, checker, reference solution, difficulty 1-10, tags, split public|private) for a suite. It runs the full validation pipeline and returns status/quality/reasons.",
    schema: {
      required: ["suite_id", "task", "checker", "reference"],
      properties: {
        suite_id: { type: "string" },
        task: { type: "string" },
        inputs: { type: "object" },
        checker: { type: "object", description: "exact|regex|json_schema|numeric|contains|rubric" },
        reference: { type: "string", description: "reference solution (never shown to solvers)" },
        difficulty: { type: "number" },
        tags: { type: "array" },
        split: { type: "string", description: "public | private" },
      },
    },
    handler: evalAuthor,
  },
  {
    id: "eval.list_public",
    name: "List public eval items",
    tier: 1,
    description: "List ACTIVE PUBLIC eval items (task, inputs, difficulty, tags, answer format). No references, no checkers, no private items.",
    schema: { properties: { suite_id: { type: "string" }, limit: { type: "number" } } },
    handler: async (c, a) => {
      const limit = Math.max(1, Math.min(Number(a.limit ?? 20) || 20, 50));
      return listPublicItems(c.env, a.suite_id ? String(a.suite_id) : undefined, limit);
    },
  },
  forgeSubmitTool,
  {
    id: "sandbox.eval",
    name: "Sandbox eval",
    tier: 2,
    description: "Evaluate an arithmetic expression in the sandbox (P1 stub; full WASM sandbox in P4).",
    schema: { required: ["expression"], properties: { expression: { type: "string" } } },
    handler: async (_c, a) => ({ value: evalArithmetic(String(a.expression)) }),
  },
  {
    id: "http.get",
    name: "HTTP GET (external read)",
    tier: 3,
    description: "Read a public https URL. Requires owner approval.",
    schema: { required: ["url"], properties: { url: { type: "string" } } },
    handler: async (c, a) => {
      if (!c.approved) throw new Error("http.get requires owner approval");
      const url = new URL(String(a.url));
      if (url.protocol !== "https:") throw new Error("only https URLs");
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Khaliya/0.1" } });
      const text = (await res.text()).slice(0, 4000);
      return { status: res.status, text };
    },
  },
  {
    id: "email.send",
    name: "Send email",
    tier: 4,
    description: "Send an email on the owner's behalf. Owner approval + step-up required.",
    schema: { required: ["to", "subject", "body"], properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } } },
    handler: async () => ({ effect: "none", note: P1_NO_EFFECT }),
  },
  {
    id: "web.publish",
    name: "Publish",
    tier: 4,
    description: "Publish content publicly. Owner approval + step-up required.",
    schema: { required: ["target", "content"], properties: { target: { type: "string" }, content: { type: "string" } } },
    handler: async () => ({ effect: "none", note: P1_NO_EFFECT }),
  },
  {
    id: "spend.request",
    name: "Request spending",
    tier: 4,
    description: "Ask the owner to spend money. Always denied by policy unless the owner approves; P1 never spends.",
    schema: { required: ["amount_usd", "purpose"], properties: { amount_usd: { type: "number" }, purpose: { type: "string" } } },
    handler: async () => ({ effect: "none", note: P1_NO_EFFECT }),
  },
  kbSearchTool, // "kb.search" T0
  kbWriteTool, // "kb.write" T1
];

export const TOOL_MAP: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

export function describeTools(ids: string[]): string {
  return ids
    .map((id) => TOOL_MAP[id])
    .filter(Boolean)
    .map((t) => `- ${t.id} (T${t.tier}): ${t.description} args: ${JSON.stringify(Object.keys(t.schema.properties))}`)
    .join("\n");
}
