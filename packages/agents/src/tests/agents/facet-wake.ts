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

  async onJob({ job }: LifecycleJobContext): Promise<void> {
    // `slow-*` outruns the root's drive budget; `fail-*` throws.
    if (job.id.startsWith("slow")) {
      await new Promise((resolve) => setTimeout(resolve, 6_500));
    }
    this.host
      .sql`INSERT INTO facet_wake_runs (id, at) VALUES (${job.id}, ${Date.now()})`;
    if (job.id.startsWith("fail")) throw new Error("facet job failed");
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

/** Drive calls into a middle facet that fail before they reach it. */
let failingDrives = 0;

/** Third level: root -> middle -> leaf. */
export class FacetWakeLeaf extends WakeAgent {}

export class FacetWakeMiddle extends WakeAgent {
  override async _cf_routeLifecycle(
    target: Parameters<Agent["_cf_routeLifecycle"]>[0],
    envelope: Parameters<Agent["_cf_routeLifecycle"]>[1]
  ): Promise<unknown> {
    if (
      failingDrives > 0 &&
      (envelope.payload as { type?: string }).type === "drive"
    ) {
      failingDrives -= 1;
      throw new Error("simulated facet start failure");
    }
    return super._cf_routeLifecycle(target, envelope);
  }

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

  async middlePending(name: string): Promise<string[]> {
    return (await this.subAgent(FacetWakeMiddle, name)).pendingJobs();
  }

  failNextFacetDrives(count: number): void {
    failingDrives = count;
  }

  /** Send this root a facet's wake report, as the facet would. */
  async reportFacetWake(
    key: string,
    time: number | null,
    stamp: number
  ): Promise<void> {
    await this._cf_routeLifecycle(undefined, {
      capability: "cf:facet-wake",
      source: { key, data: "[]" },
      payload: { type: "arm", time, stamp }
    });
  }

  /** Record that a path's drives ended unreported, as after a tree reset. */
  markUnreportedDrives(key: string, count: number): void {
    this.ctx.storage.kv.put(`cf_agents:facet_drives:${key}`, {
      count,
      at: Date.now()
    });
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
