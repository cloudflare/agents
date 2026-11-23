import { Agent } from "../../index.ts";
import {
  LifecycleCapability,
  type LifecycleJobContext
} from "../../lifecycle/index.ts";

/**
 * Records every job it runs in its own storage, so a test can read whether
 * a facet's job ran and in which facet.
 */
class WakeProbe extends LifecycleCapability {
  constructor(private readonly host: Agent) {
    super("facet-wake-probe");
  }

  onStart(): void {
    this.host.sql`CREATE TABLE IF NOT EXISTS facet_wake_runs (
      id TEXT NOT NULL, at INTEGER NOT NULL
    )`;
  }

  onJob({ job }: LifecycleJobContext): void {
    this.host
      .sql`INSERT INTO facet_wake_runs (id, at) VALUES (${job.id}, ${Date.now()})`;
  }

  push(id: string, delayMs: number) {
    return this.lifecycle.jobs.push({
      id,
      fn: "run",
      time: Date.now() + delayMs
    });
  }

  list() {
    return this.lifecycle.jobs.list().map((job) => job.id);
  }
}

abstract class WakeAgent extends Agent<Cloudflare.Env> {
  readonly probe = new WakeProbe(this);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.lifecycle.use(this.probe);
  }

  async pushJob(id: string, delayMs: number): Promise<string[]> {
    await this.probe.push(id, delayMs);
    return this.probe.list();
  }

  ran(): string[] {
    return this.sql<{
      id: string;
    }>`SELECT id FROM facet_wake_runs ORDER BY at`.map((row) => row.id);
  }

  pendingJobs(): string[] {
    return this.probe.list();
  }
}

/** Third level: root -> middle -> leaf. */
export class FacetWakeLeaf extends WakeAgent {}

export class FacetWakeMiddle extends WakeAgent {
  async leafPush(name: string, id: string, delayMs: number) {
    return (await this.subAgent(FacetWakeLeaf, name)).pushJob(id, delayMs);
  }

  async leafRan(name: string): Promise<string[]> {
    return (await this.subAgent(FacetWakeLeaf, name)).ran();
  }

  async leafPending(name: string): Promise<string[]> {
    return (await this.subAgent(FacetWakeLeaf, name)).pendingJobs();
  }
}

export class FacetWakeRoot extends WakeAgent {
  async middlePush(name: string, id: string, delayMs: number) {
    return (await this.subAgent(FacetWakeMiddle, name)).pushJob(id, delayMs);
  }

  async middleRan(name: string): Promise<string[]> {
    return (await this.subAgent(FacetWakeMiddle, name)).ran();
  }

  async leafPush(middle: string, leaf: string, id: string, delayMs: number) {
    return (await this.subAgent(FacetWakeMiddle, middle)).leafPush(
      leaf,
      id,
      delayMs
    );
  }

  async leafRan(middle: string, leaf: string): Promise<string[]> {
    return (await this.subAgent(FacetWakeMiddle, middle)).leafRan(leaf);
  }

  async leafPending(middle: string, leaf: string): Promise<string[]> {
    return (await this.subAgent(FacetWakeMiddle, middle)).leafPending(leaf);
  }

  async deleteMiddle(name: string): Promise<void> {
    await this.deleteSubAgent(FacetWakeMiddle, name);
  }

  rootJobs(): { id: string; capability: string; time: number }[] {
    return this.sql<{ id: string; capability: string; time: number }>`
      SELECT id, capability, time FROM cf_agents_jobs ORDER BY time`;
  }

  async alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}
