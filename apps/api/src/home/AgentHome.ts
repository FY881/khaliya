import { DurableObject } from "cloudflare:workers";
import { RUNNABLE, type AgentStatus } from "../constitution";
import type { Env } from "../env";
import { audit } from "../audit";
import { Governor, GovernorError } from "../governor/governor";
import { ModelRouter } from "../llm/router";
import { Registry } from "../registry/registry";
import { resolveCaps, runAgentLoop, type RunCaps, type RunResult, type TraceEvent } from "../runtime/loop";
import { TOOL_MAP, type MemoryStore } from "../tools/catalog";
import { ToolGateway } from "../tools/gateway";
import { describeForgeTools } from "../forge/tool";
import { newId, safeJsonParse, truncate } from "../util";

export interface RunSummary {
  run_id: string;
  status: RunResult["status"] | "rejected";
  stop_reason: string;
  final: string | null;
  steps: number;
  tokens: number;
  tool_calls: number;
  llm_calls: number;
  wall_ms: number;
  lessons: string[];
}

function terms(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 32))];
}

/**
 * One Durable Object per agent (named by agent id). Private SQLite holds memory, inbox,
 * task queue and run traces. Single-threaded → no races within an agent.
 */
export class AgentHome extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, meta TEXT, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS tasks (run_id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS trace (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, phase TEXT NOT NULL, step INTEGER, summary TEXT NOT NULL, data TEXT, PRIMARY KEY (run_id, seq));
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
    });
  }

  // ---------------- state helpers ----------------
  private getState(key: string): string | null {
    const r = this.sql.exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key).toArray()[0];
    return r?.value ?? null;
  }
  private setState(key: string, value: string) {
    this.sql.exec("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // ---------------- memory ----------------
  readonly memoryStore: MemoryStore = {
    write: async (kind, text, meta) => {
      const row = this.sql
        .exec<{ id: number }>("INSERT INTO memory (kind, text, meta, at) VALUES (?, ?, ?, ?) RETURNING id", kind, text, meta ? JSON.stringify(meta) : null, Date.now())
        .one();
      // keep the home small: cap at 2000 items
      this.sql.exec("DELETE FROM memory WHERE id IN (SELECT id FROM memory ORDER BY id DESC LIMIT -1 OFFSET 2000)");
      return { id: row.id };
    },
    search: async (query, k) => {
      const q = terms(query);
      const rows = this.sql.exec<{ id: number; kind: string; text: string; at: number }>("SELECT id, kind, text, at FROM memory ORDER BY id DESC LIMIT 500").toArray();
      const newest = rows[0]?.id ?? 0;
      return rows
        .map((r) => {
          const t = r.text.toLowerCase();
          const hits = q.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
          const score = hits + (r.kind === "lesson" ? 0.5 : 0) + 0.3 * (1 - (newest - r.id) / 500);
          return { ...r, score, hits };
        })
        .filter((r) => r.hits > 0 || q.length === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ hits: _h, ...r }) => r);
    },
  };

  // ---------------- RPC: inbox ----------------
  async deliver(from: string, text: string): Promise<void> {
    this.sql.exec("INSERT INTO inbox (from_id, text, at) VALUES (?, ?, ?)", from, truncate(text, 4000), Date.now());
    this.sql.exec("DELETE FROM inbox WHERE id IN (SELECT id FROM inbox ORDER BY id DESC LIMIT -1 OFFSET 200)");
  }

  // ---------------- RPC: tasks ----------------
  /** Queue a task and wake via alarm (free; no Queues needed). */
  async enqueue(agentId: string, task: string, runId = newId("run")): Promise<string> {
    this.setState("agent_id", agentId);
    this.sql.exec("INSERT INTO tasks (run_id, task, status, created_at) VALUES (?, ?, 'queued', ?)", runId, truncate(task, 4000), Date.now());
    await this.env.DB.prepare("INSERT INTO runs (id, agent_id, genome_id, task, status, created_at) VALUES (?1, ?2, '', ?3, 'queued', ?4)")
      .bind(runId, agentId, truncate(task, 4000), Date.now())
      .run();
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 10);
    return runId;
  }

  async alarm(): Promise<void> {
    const agentId = this.getState("agent_id");
    const next = this.sql.exec<{ run_id: string; task: string }>("SELECT run_id, task FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT 1").toArray()[0];
    if (!agentId || !next) return;
    this.sql.exec("UPDATE tasks SET status = 'running' WHERE run_id = ?", next.run_id);
    try {
      await this.runTask(agentId, next.task, { runId: next.run_id });
    } finally {
      this.sql.exec("UPDATE tasks SET status = 'done' WHERE run_id = ?", next.run_id);
      const more = this.sql.exec("SELECT 1 FROM tasks WHERE status = 'queued' LIMIT 1").toArray().length > 0;
      if (more) await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }

  /** Execute one run now (perceive → retrieve → plan → act → reflect → memory). */
  async runTask(agentId: string, task: string, opts: { runId?: string; caps?: Partial<RunCaps>; seed?: string } = {}): Promise<RunSummary> {
    this.setState("agent_id", agentId);
    const runId = opts.runId ?? newId("run");
    const reg = new Registry(this.env);
    const gov = new Governor(this.env);
    const reject = async (reason: string): Promise<RunSummary> => {
      await this.env.DB.prepare(
        "INSERT INTO runs (id, agent_id, genome_id, task, status, stop_reason, created_at, finished_at) VALUES (?1, ?2, '', ?3, 'rejected', ?4, ?5, ?5) ON CONFLICT(id) DO UPDATE SET status = 'rejected', stop_reason = excluded.stop_reason, finished_at = excluded.finished_at",
      )
        .bind(runId, agentId, truncate(task, 4000), reason, Date.now())
        .run();
      await audit(this.env.DB, "governor", "run.rejected", runId, { agent: agentId, reason });
      return { run_id: runId, status: "rejected", stop_reason: reason, final: null, steps: 0, tokens: 0, tool_calls: 0, llm_calls: 0, wall_ms: 0, lessons: [] };
    };

    const agent = await reg.getAgent(agentId);
    if (!agent) return reject("agent not found");
    if (!RUNNABLE.includes(agent.status as AgentStatus)) return reject(`agent status '${agent.status}' cannot run`);
    const killed = await gov.isKilled(agentId);
    if (killed.killed) return reject(`kill switch (${killed.scope}) is ON`);
    const runBudget = await gov.debit(agentId, "runs", 1);
    if (!runBudget.ok) return reject(`daily runs cap reached (${runBudget.scope})`);
    const genome = await reg.getGenome(agent.genome_id);
    if (!genome) return reject("genome missing");

    const caps = resolveCaps(genome, opts.caps);
    const t0 = Date.now();
    await this.env.DB.prepare(
      "INSERT INTO runs (id, agent_id, genome_id, task, status, seed, created_at) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6) ON CONFLICT(id) DO UPDATE SET genome_id = excluded.genome_id, status = 'running', seed = excluded.seed",
    )
      .bind(runId, agentId, genome.id, truncate(task, 4000), opts.seed ?? null, t0)
      .run();
    await audit(this.env.DB, `agent:${agentId}`, "run.start", runId, { genome: genome.id, caps });
    this.setState("current", JSON.stringify({ run_id: runId, task, started_at: t0 }));

    const inbox = this.sql.exec<{ from_id: string; text: string; at: number }>("SELECT from_id, text, at FROM inbox WHERE read = 0 ORDER BY id DESC LIMIT 10").toArray().reverse();
    let seq = 0;
    const onTrace = (e: TraceEvent) => {
      this.sql.exec(
        "INSERT INTO trace (run_id, seq, at, phase, step, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        runId,
        seq++,
        e.at,
        e.phase,
        e.step ?? null,
        truncate(e.summary, 500),
        e.data === undefined ? null : truncate(JSON.stringify(e.data), 4000),
      );
    };

    const router = new ModelRouter(this.env, { agentId });
    const gateway = new ToolGateway({
      env: this.env,
      agentId,
      runId,
      role: genome.role,
      lineage: genome.lineage_id,
      memory: this.memoryStore,
      sandboxed: agent.status === "sandboxed",
      genomeToolIds: genome.tool_ids,
    });

    let result: RunResult;
    try {
      result = await runAgentLoop({
        genome,
        agentId,
        runId,
        task,
        inbox: inbox.map((m) => ({ from: m.from_id, text: m.text, at: m.at })),
        llm: router,
        gateway,
        memory: this.memoryStore,
        governor: gov,
        caps,
        onTrace,
        seed: opts.seed,
        extraToolDocs: await describeForgeTools(this.env, genome.tool_ids).catch(() => ""),
      });
    } catch (e) {
      const msg = e instanceof GovernorError ? e.message : String((e as Error)?.message ?? e);
      result = { status: "failed", stop_reason: msg, final: null, steps: 0, tokens: 0, tool_calls: 0, llm_calls: 0, wall_ms: Date.now() - t0, lessons: [], plan: [], prompt_hash: "", trace: [] };
    }

    this.sql.exec("UPDATE inbox SET read = 1 WHERE read = 0");
    this.setState("current", "null");
    this.setState("last_run", runId);
    // prune old traces (keep last 50 runs)
    this.sql.exec("DELETE FROM trace WHERE run_id NOT IN (SELECT DISTINCT run_id FROM trace ORDER BY at DESC LIMIT 50)");

    const traceJson = truncate(JSON.stringify(result.trace.map((t) => ({ ...t, data: t.data === undefined ? undefined : truncate(JSON.stringify(t.data), 600) }))), 64_000);
    await this.env.DB.prepare(
      "UPDATE runs SET status = ?2, stop_reason = ?3, steps = ?4, tokens = ?5, tool_calls = ?6, llm_calls = ?7, wall_ms = ?8, result = ?9, trace = ?10, prompt_hash = ?11, finished_at = ?12 WHERE id = ?1",
    )
      .bind(runId, result.status, result.stop_reason, result.steps, result.tokens, result.tool_calls, result.llm_calls, result.wall_ms, result.final, traceJson, result.prompt_hash, Date.now())
      .run();
    await audit(this.env.DB, `agent:${agentId}`, "run.finish", runId, { status: result.status, reason: result.stop_reason, steps: result.steps, tokens: result.tokens, attempts: router.attempts.slice(-6) });

    return {
      run_id: runId,
      status: result.status,
      stop_reason: result.stop_reason,
      final: result.final,
      steps: result.steps,
      tokens: result.tokens,
      tool_calls: result.tool_calls,
      llm_calls: result.llm_calls,
      wall_ms: result.wall_ms,
      lessons: result.lessons,
    };
  }

  // ---------------- RPC: desk view ----------------
  async desk(agentId: string) {
    this.setState("agent_id", agentId);
    const reg = new Registry(this.env);
    const agent = await reg.getAgent(agentId);
    const genome = agent ? await reg.getGenome(agent.genome_id) : null;
    const lastRun = this.getState("last_run");
    const current = safeJsonParse(this.getState("current"));
    const traceRunId = (current as any)?.run_id ?? lastRun;
    const trace = traceRunId
      ? this.sql
          .exec<any>("SELECT seq, at, phase, step, summary, data FROM trace WHERE run_id = ? ORDER BY seq", traceRunId)
          .toArray()
          .map((r) => ({ ...r, data: safeJsonParse(r.data) }))
      : [];
    return {
      agent,
      genome,
      current,
      trace_run_id: traceRunId,
      trace,
      queue: this.sql.exec<any>("SELECT run_id, task, status, created_at FROM tasks ORDER BY created_at DESC LIMIT 20").toArray(),
      memory: this.sql.exec<any>("SELECT id, kind, text, at FROM memory ORDER BY id DESC LIMIT 50").toArray(),
      memory_count: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memory").one().n,
      inbox: this.sql.exec<any>("SELECT id, from_id, text, at, read FROM inbox ORDER BY id DESC LIMIT 30").toArray(),
      tools: (genome?.tool_ids ?? []).map((id) => {
        const t = TOOL_MAP[id];
        if (t) return { id: t.id, name: t.name, tier: t.tier, description: t.description };
        if (id.startsWith("forge.")) return { id, name: id, tier: 1, description: id === "forge.*" ? "every admitted forged tool (sandboxed)" : "forged tool (sandboxed, usable while admitted)" };
        return { id, name: id, tier: -1, description: "unknown tool" };
      }),
    };
  }

  async traceFor(runId: string) {
    return this.sql
      .exec<any>("SELECT seq, at, phase, step, summary, data FROM trace WHERE run_id = ? ORDER BY seq", runId)
      .toArray()
      .map((r) => ({ ...r, data: safeJsonParse(r.data) }));
  }

  async memoryCount(): Promise<number> {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memory").one().n;
  }
}
