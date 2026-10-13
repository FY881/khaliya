import { CONSTITUTION } from "../constitution";
import type { Genome } from "../genome/schema";
import { GovernorError } from "../governor/governor";
import type { ChatMessage, LlmRequest, LlmResponse } from "../llm/types";
import type { GatewayResult } from "../tools/gateway";
import { describeTools, type MemoryStore } from "../tools/catalog";
import { canonicalJson, extractJson, sha256Hex, truncate } from "../util";

export interface RunCaps {
  max_steps: number;
  max_tokens: number;
  max_tool_calls: number;
  max_llm_calls: number;
  max_wall_ms: number;
}

/** Genome may only LOWER the constitutional hard caps. */
export function resolveCaps(genome: Pick<Genome, "budget_profile">, override?: Partial<RunCaps>): RunCaps {
  const hard = CONSTITUTION.runHardCaps;
  const def = CONSTITUTION.runDefaultCaps;
  const bp = genome.budget_profile ?? {};
  const pick = (k: keyof RunCaps) => Math.max(1, Math.min(hard[k], override?.[k] ?? bp[k] ?? def[k]));
  return {
    max_steps: pick("max_steps"),
    max_tokens: pick("max_tokens"),
    max_tool_calls: pick("max_tool_calls"),
    max_llm_calls: pick("max_llm_calls"),
    max_wall_ms: pick("max_wall_ms"),
  };
}

export type Phase = "perceive" | "retrieve" | "plan" | "act" | "observe" | "reflect" | "memory" | "stop";
export interface TraceEvent {
  at: number;
  phase: Phase;
  step?: number;
  summary: string;
  data?: unknown;
  tokens?: number;
  model?: string;
}

export interface LoopDeps {
  genome: Genome;
  agentId: string;
  runId: string;
  task: string;
  inbox?: { from: string; text: string; at?: number }[];
  llm: { complete(req: LlmRequest, policy?: Genome["model_policy"]): Promise<LlmResponse> };
  gateway: { call(tool: string, args: Record<string, any>): Promise<GatewayResult> };
  memory: MemoryStore;
  governor: { assertMayContinue(agentId: string): Promise<void> };
  caps: RunCaps;
  clock?: () => number;
  onTrace?: (e: TraceEvent) => void | Promise<void>;
  seed?: string;
  /** Extra tool lines (admitted forged tools the genome is granted), appended to the built-in tool list. */
  extraToolDocs?: string;
}

export type RunStatus = "done" | "capped" | "killed" | "failed";
export interface RunResult {
  status: RunStatus;
  stop_reason: string;
  final: string | null;
  steps: number;
  tokens: number;
  tool_calls: number;
  llm_calls: number;
  wall_ms: number;
  lessons: string[];
  plan: string[];
  prompt_hash: string;
  trace: TraceEvent[];
}

class CapHit extends Error {
  constructor(public cap: string) {
    super(`cap reached: ${cap}`);
  }
}

const RESPONSE_CONTRACT = `Reply with ONE JSON object and nothing else.
To use a tool: {"thought": "...", "action": {"tool": "<tool id>", "args": {...}}}
To finish:     {"thought": "...", "final": "<your answer>"}`;

export async function runAgentLoop(d: LoopDeps): Promise<RunResult> {
  const clock = d.clock ?? Date.now;
  const t0 = clock();
  const trace: TraceEvent[] = [];
  const s = { steps: 0, tokens: 0, tool_calls: 0, llm_calls: 0 };
  let plan: string[] = [];
  let lessons: string[] = [];
  let final: string | null = null;
  let status: RunStatus = "done";
  let stop_reason = "final_answer";

  const emit = async (e: Omit<TraceEvent, "at">) => {
    const ev = { at: clock(), ...e };
    trace.push(ev);
    await d.onTrace?.(ev);
  };

  const elapsed = () => clock() - t0;
  const assertCaps = (need: "llm" | "tool" | "step") => {
    if (elapsed() >= d.caps.max_wall_ms) throw new CapHit("max_wall_ms");
    if (s.tokens >= d.caps.max_tokens) throw new CapHit("max_tokens");
    if (need === "llm" && s.llm_calls >= d.caps.max_llm_calls) throw new CapHit("max_llm_calls");
    if (need === "tool" && s.tool_calls >= d.caps.max_tool_calls) throw new CapHit("max_tool_calls");
    if (need === "step" && s.steps >= d.caps.max_steps) throw new CapHit("max_steps");
  };

  const toolIds = d.genome.tool_ids;
  const system = [
    d.genome.system_prompt,
    `You are agent ${d.agentId} (role: ${d.genome.role}) in the Khaliya organization. Strategy: ${d.genome.planning_strategy}.`,
    "Rules you cannot change: " + CONSTITUTION.articles.join(" "),
    toolIds.length ? `Your tools:\n${[describeTools(toolIds), d.extraToolDocs ?? ""].filter(Boolean).join("\n")}` : "You have no tools; think and answer.",
    "External (T3/T4) tools go to the owner's approval queue; you will not get their result in this run.",
  ].join("\n\n");
  const prompt_hash = await sha256Hex(canonicalJson({ system, genome: d.genome.id, seed: d.seed ?? null }));

  const llm = async (messages: ChatMessage[], json = true): Promise<LlmResponse> => {
    assertCaps("llm");
    await d.governor.assertMayContinue(d.agentId);
    const remainingTokens = d.caps.max_tokens - s.tokens;
    const remainingMs = d.caps.max_wall_ms - elapsed();
    s.llm_calls++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new CapHit("max_wall_ms")), Math.max(1, remainingMs));
    });
    try {
      const res = await Promise.race([
        d.llm.complete(
          { messages: [{ role: "system", content: system }, ...messages], json, maxTokens: Math.max(64, Math.min(1024, remainingTokens)), temperature: d.genome.model_policy.temperature },
          d.genome.model_policy,
        ),
        timeout,
      ]);
      s.tokens += res.tokensIn + res.tokensOut;
      return res;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const transcript: ChatMessage[] = [];
  try {
    // 1. PERCEIVE
    await d.governor.assertMayContinue(d.agentId);
    const inbox = (d.inbox ?? []).slice(-10);
    await emit({ phase: "perceive", summary: `task received; ${inbox.length} inbox message(s)`, data: { task: d.task, inbox } });

    // 2. RETRIEVE
    const k = d.genome.memory_policy?.working_k ?? 6;
    const memories = k > 0 ? await d.memory.search(d.task, k) : [];
    await emit({ phase: "retrieve", summary: `${memories.length} memory item(s) retrieved`, data: memories.map((m) => truncate(m.text, 200)) });

    const context = [
      `TASK: ${d.task}`,
      memories.length ? `MEMORY:\n${memories.map((m) => `- [${m.kind}] ${truncate(m.text, 300)}`).join("\n")}` : "MEMORY: (none)",
      inbox.length ? `INBOX:\n${inbox.map((m) => `- from ${m.from}: ${truncate(m.text, 300)}`).join("\n")}` : "INBOX: (empty)",
    ].join("\n\n");

    // 3. PLAN
    const planRes = await llm([{ role: "user", content: `${context}\n\nPHASE: plan\nReturn {"plan": ["step", ...]} with at most 5 short steps.` }]);
    plan = (extractJson<{ plan?: unknown }>(planRes.text)?.plan as string[] | undefined)?.filter((x) => typeof x === "string").slice(0, 5) ?? [];
    await emit({ phase: "plan", summary: plan.length ? plan.join(" → ") : "(no structured plan)", tokens: planRes.tokensIn + planRes.tokensOut, model: planRes.model });

    transcript.push({ role: "user", content: `${context}\n\nPLAN: ${JSON.stringify(plan)}\n\nPHASE: act\n${RESPONSE_CONTRACT}` });

    // 4. ACT (+ observe)
    for (;;) {
      assertCaps("step");
      s.steps++;
      const res = await llm(transcript);
      transcript.push({ role: "assistant", content: res.text });
      const msg = extractJson<{ thought?: string; action?: { tool?: string; args?: Record<string, any> }; final?: unknown }>(res.text);
      if (!msg) {
        await emit({ phase: "act", step: s.steps, summary: "unparseable reply", data: truncate(res.text, 300), tokens: res.tokensIn + res.tokensOut, model: res.model });
        transcript.push({ role: "user", content: `OBSERVATION (system): your reply was not valid JSON.\nPHASE: act\n${RESPONSE_CONTRACT}` });
        continue;
      }
      if (msg.final !== undefined && msg.final !== null) {
        final = typeof msg.final === "string" ? msg.final : JSON.stringify(msg.final);
        await emit({ phase: "act", step: s.steps, summary: `final: ${truncate(final, 160)}`, data: { thought: msg.thought }, tokens: res.tokensIn + res.tokensOut, model: res.model });
        break;
      }
      const tool = msg.action?.tool;
      if (!tool) {
        transcript.push({ role: "user", content: `OBSERVATION (system): no action and no final.\nPHASE: act\n${RESPONSE_CONTRACT}` });
        await emit({ phase: "act", step: s.steps, summary: "no action", tokens: res.tokensIn + res.tokensOut, model: res.model });
        continue;
      }
      await emit({ phase: "act", step: s.steps, summary: `${tool}(${truncate(JSON.stringify(msg.action?.args ?? {}), 120)})`, data: { thought: msg.thought }, tokens: res.tokensIn + res.tokensOut, model: res.model });
      assertCaps("tool");
      s.tool_calls++;
      const out = await d.gateway.call(tool, msg.action?.args ?? {});
      const obs = truncate(JSON.stringify(out), 1500);
      await emit({ phase: "observe", step: s.steps, summary: `${tool} → ${out.status}`, data: out });
      transcript.push({ role: "user", content: `OBSERVATION (${tool}): ${obs}\nPHASE: act\n${RESPONSE_CONTRACT}` });
    }
  } catch (e) {
    if (e instanceof CapHit) {
      status = "capped";
      stop_reason = e.cap;
    } else if (e instanceof GovernorError) {
      status = e.code === "killed" ? "killed" : "capped";
      stop_reason = e.code === "killed" ? e.message : `governor: ${e.message}`;
    } else {
      status = "failed";
      stop_reason = String((e as Error)?.message ?? e).slice(0, 300);
    }
    await emit({ phase: "stop", summary: `${status}: ${stop_reason}` });
  }

  // 5. REFLECT — only if the run was not killed and budget remains.
  if (status !== "killed" && d.genome.memory_policy?.write_lessons !== false) {
    try {
      const r = await llm([
        ...transcript.slice(0, 1),
        { role: "user", content: `PHASE: reflect\nOutcome: ${status} (${stop_reason}). Final: ${truncate(final ?? "none", 400)}\nReturn {"lessons": ["short reusable lesson", ...], "self_score": 0..1} (max 3 lessons).` },
      ]);
      lessons = ((extractJson<{ lessons?: unknown }>(r.text)?.lessons as string[] | undefined) ?? []).filter((x) => typeof x === "string").slice(0, 3);
      await emit({ phase: "reflect", summary: lessons.length ? lessons.join(" | ") : "(no lessons)", tokens: r.tokensIn + r.tokensOut, model: r.model });
    } catch (e) {
      await emit({ phase: "reflect", summary: `skipped: ${(e as Error).message}` });
    }
  }

  // 6. MEMORY — episode summary always; lessons when allowed.
  try {
    await d.memory.write("episode", `Task: ${truncate(d.task, 300)} | outcome: ${status} (${stop_reason}) | answer: ${truncate(final ?? "-", 300)}`, { run: d.runId });
    for (const l of lessons) await d.memory.write("lesson", l, { run: d.runId });
    await emit({ phase: "memory", summary: `stored episode + ${lessons.length} lesson(s)` });
  } catch (e) {
    await emit({ phase: "memory", summary: `memory write failed: ${(e as Error).message}` });
  }

  return { status, stop_reason, final, ...s, wall_ms: elapsed(), lessons, plan, prompt_hash, trace };
}
