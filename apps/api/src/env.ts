import type { AgentHome } from "./home/AgentHome";
import type { JobRunner } from "./jobs/runner";

export interface Env {
  DB: D1Database;
  AGENT_HOME: DurableObjectNamespace<AgentHome>;
  /** Singleton background-job runner (lab work in alarm-driven chunks). */
  JOB_RUNNER?: DurableObjectNamespace<JobRunner>;
  AI?: Ai;
  /** Vectorize index for KB embeddings (@cf/baai/bge-m3, 1024 dims). Optional: D1 FTS5 is used when unbound. */
  KB_VECTORS?: Vectorize;
  KB_EMBED?: string; // "off" disables embeddings
  ASSETS?: Fetcher;
  JOBS?: Queue<JobMessage>;
  APP_NAME?: string;
  LLM_MODE?: string; // "auto" | "mock"
  CONSOLE_ORIGIN?: string;
  QUOTA_MARGIN?: string;
  POPULATION_CAP?: string;
  EVOLUTION_AUTO?: string; // "on" = the */30 cron runs one evolution tick hourly; default "off"
  /** Sandbox fuel cap for forged tools / admission runs on the free plan (ticks per run). Unset = tool's own limit. */
  FORGE_FUEL_CAP?: string;
  // secrets
  OWNER_TOTP_SECRET?: string;
  SESSION_SECRET?: string;
  GEMINI_KEY?: string;
  OPENROUTER_KEY?: string;
}

export type JobMessage =
  | { kind: "run"; agent_id: string; task: string; run_id: string }
  | { kind: "tick" };
