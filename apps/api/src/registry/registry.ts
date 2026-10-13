import { CONSTITUTION, canTransition, type AgentStatus } from "../constitution";
import type { Env } from "../env";
import { audit } from "../audit";
import { finalizeGenome, validateGenome, verifyGenomeId, type Genome, type GenomeInput } from "../genome/schema";
import { Governor } from "../governor/governor";

export interface AgentRow {
  id: string;
  lineage_id: string;
  genome_id: string;
  name: string;
  role: string;
  status: AgentStatus;
  created_at: number;
  updated_at: number;
}

export class RegistryError extends Error {
  constructor(
    public code: "invalid_genome" | "not_found" | "bad_transition" | "conflict" | "protected",
    message: string,
    public details?: string[],
  ) {
    super(message);
  }
}

export class Registry {
  constructor(private env: Env) {}
  private get db() {
    return this.env.DB;
  }

  // ---------- genomes ----------
  async putGenome(input: GenomeInput, actor: string): Promise<Genome> {
    const g = await finalizeGenome(input);
    const v = validateGenome(g);
    if (!v.ok) throw new RegistryError("invalid_genome", "genome failed validation", v.errors);
    if (input.id && input.id !== g.id) throw new RegistryError("invalid_genome", "supplied id does not match content hash");
    // Separation of powers: protected lineages can only be written by the owner/system.
    const lin = await this.db.prepare("SELECT protected FROM lineages WHERE id = ?1").bind(g.lineage_id).first<{ protected: number }>();
    if (lin?.protected && actor.startsWith("agent:")) throw new RegistryError("protected", `lineage ${g.lineage_id} is protected`);
    if (!lin) {
      await this.db
        .prepare("INSERT INTO lineages (id, role, name, protected, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(g.lineage_id, g.role, g.name, CONSTITUTION.protectedRoles.includes(g.role) ? 1 : 0, Date.now())
        .run();
    }
    const existing = await this.db.prepare("SELECT id FROM genomes WHERE id = ?1").bind(g.id).first();
    if (!existing) {
      await this.db
        .prepare("INSERT INTO genomes (id, lineage_id, version, role, parent_ids, body, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
        .bind(g.id, g.lineage_id, g.version, g.role, JSON.stringify(g.parent_ids), JSON.stringify(g), g.created_by, g.created_at)
        .run();
      await this.db
        .prepare("INSERT OR IGNORE INTO elo_ratings (genome_id, role, rating, rd, matches, updated_at) VALUES (?1, ?2, 1200, 350, 0, ?3)")
        .bind(g.id, g.role, Date.now())
        .run();
      await audit(this.db, actor, "genome.create", g.id, { lineage: g.lineage_id, version: g.version });
    }
    return g;
  }

  async getGenome(id: string): Promise<Genome | null> {
    const r = await this.db.prepare("SELECT body FROM genomes WHERE id = ?1").bind(id).first<{ body: string }>();
    if (!r) return null;
    const g = JSON.parse(r.body) as Genome;
    if (!(await verifyGenomeId(g))) throw new RegistryError("conflict", `genome ${id} failed integrity check`);
    return g;
  }

  async listGenomes(lineage?: string): Promise<{ id: string; lineage_id: string; version: number; role: string; created_at: number }[]> {
    const q = lineage
      ? this.db.prepare("SELECT id, lineage_id, version, role, parent_ids, created_by, created_at FROM genomes WHERE lineage_id = ?1 ORDER BY version DESC").bind(lineage)
      : this.db.prepare("SELECT id, lineage_id, version, role, parent_ids, created_by, created_at FROM genomes ORDER BY created_at DESC LIMIT 200");
    return (await q.all<any>()).results;
  }

  // ---------- agents ----------
  async createAgent(genome: Genome, opts: { id?: string; status?: AgentStatus; actor: string }): Promise<AgentRow> {
    const status = opts.status ?? "draft";
    await new Governor(this.env).assertPopulationRoom(status);
    const id = opts.id ?? `a_${genome.lineage_id}`;
    const exists = await this.db.prepare("SELECT id FROM agents WHERE id = ?1").bind(id).first();
    if (exists) throw new RegistryError("conflict", `agent ${id} already exists`);
    const t = Date.now();
    await this.db
      .prepare("INSERT INTO agents (id, lineage_id, genome_id, name, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)")
      .bind(id, genome.lineage_id, genome.id, genome.name, genome.role, status, t)
      .run();
    await audit(this.db, opts.actor, "agent.create", id, { genome: genome.id, status });
    if (status === "champion") await this.deploy(genome, id, opts.actor);
    return (await this.getAgent(id))!;
  }

  async getAgent(id: string): Promise<AgentRow | null> {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?1").bind(id).first<AgentRow>();
  }

  async listAgents(): Promise<AgentRow[]> {
    return (await this.db.prepare("SELECT * FROM agents ORDER BY CASE status WHEN 'champion' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END, role").all<AgentRow>()).results;
  }

  async setStatus(id: string, to: AgentStatus, actor: string): Promise<AgentRow> {
    if (actor.startsWith("agent:")) throw new RegistryError("protected", "agents cannot change lifecycle states");
    const a = await this.getAgent(id);
    if (!a) throw new RegistryError("not_found", "agent not found");
    if (!canTransition(a.status, to)) throw new RegistryError("bad_transition", `cannot go ${a.status} → ${to}`);
    if (to === "candidate" || to === "sandboxed") await new Governor(this.env).assertPopulationRoom(to);
    await this.db.prepare("UPDATE agents SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(id, to, Date.now()).run();
    await audit(this.db, actor, "agent.status", id, { from: a.status, to });
    if (to === "champion") {
      const g = await this.getGenome(a.genome_id);
      if (g) await this.deploy(g, id, actor);
    }
    if (a.status === "champion" && to !== "champion") {
      await this.db.prepare("UPDATE deployments SET active = 0 WHERE agent_id = ?1").bind(id).run();
    }
    return (await this.getAgent(id))!;
  }

  /** Point the role's live deployment at this genome (rollback = point back). */
  async deploy(g: Genome, agentId: string, actor: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE deployments SET active = 0 WHERE role = ?1").bind(g.role),
      this.db
        .prepare(
          "INSERT INTO deployments (role, genome_id, agent_id, traffic_pct, active, deployed_at) VALUES (?1, ?2, ?3, 100, 1, ?4) ON CONFLICT(role, genome_id) DO UPDATE SET active = 1, traffic_pct = 100, deployed_at = excluded.deployed_at, agent_id = excluded.agent_id",
        )
        .bind(g.role, g.id, agentId, Date.now()),
    ]);
    await audit(this.db, actor, "deployment.set", g.role, { genome: g.id, agent: agentId });
  }

  async deployments() {
    return (await this.db.prepare("SELECT * FROM deployments ORDER BY role").all()).results;
  }
}
