import type { Env } from "../env";
import type { RunCaps } from "../runtime/loop";
import type { RunSummary } from "./AgentHome";

/** Narrow, hand-written view of the AgentHome RPC surface (keeps RPC types shallow). */
export interface AgentHomeApi {
  deliver(from: string, text: string): Promise<void>;
  enqueue(agentId: string, task: string, runId?: string): Promise<string>;
  runTask(agentId: string, task: string, opts?: { runId?: string; caps?: Partial<RunCaps>; seed?: string }): Promise<RunSummary>;
  desk(agentId: string): Promise<Record<string, any>>;
  traceFor(runId: string): Promise<any[]>;
  memoryCount(): Promise<number>;
}

export function home(env: Env, agentId: string): AgentHomeApi {
  return env.AGENT_HOME.get(env.AGENT_HOME.idFromName(agentId)) as unknown as AgentHomeApi;
}
