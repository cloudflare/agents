import { Agent } from "../../index.ts";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../../lifecycle/index.ts";

/**
 * Records every job it runs in its own storage, so a test can read whether
 * a facet's job ran and in which facet.
 */
class WakeProbe extends LifecycleCapability {
  constructor(
    private readonly host: Agent,
    name?: string
  ) {
    super("facet-wake-probe", name);
  }

  /** How a run of `id` is recorded: a named instance's carry its name. */
  #runId(id: string): string {
    return this.instanceName === undefined ? id : `${this.instanceName}:${id}`;
  }

  onStart(): void {
    this.host.sql`CREATE TABLE IF NOT EXISTS facet_wake_runs (
      id TEXT NOT NULL, at INTEGER NOT NULL
    )`;
    this.host
      .sql`INSERT INTO facet_wake_runs (id, at) VALUES ('start', ${Date.now()})`;
  }

  /** `handoff-*` jobs' handed-off work, keyed by job id. */
  readonly #handedOff = new Map<string, Promise<void>>();
  readonly #handedOffDone = new Set<string>();

  async onJob({
    job
  }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    // `handoff-*` hands off 1.5 s of work and returns at once, woken again
    // meanwhile (a renewal) until the work is done.
    if (job.id.startsWith("handoff")) {
      let work = this.#handedOff.get(job.id);
      if (!work) {
        work = new Promise((resolve) => setTimeout(resolve, 1_500));
        this.#handedOff.set(job.id, work);
        void work.then(() => {
          this.#handedOffDone.add(job.id);
          this.host
            .sql`INSERT INTO facet_wake_runs (id, at) VALUES (${this.#runId(job.id)}, ${Date.now()})`;
        });
      }
      if (this.#handedOffDone.has(job.id)) return undefined;
      this.lifecycle.trackAlarmWork(work);
      return { rescheduleAt: Date.now() + 100 };
    }
    // `slow-*` outruns the root's drive budget; `fail-*` throws; `abort-*`
    // ends the isolate, the way a job over the memory limit does.
    if (job.id.startsWith("abort")) {
      (this.host as unknown as { ctx: DurableObjectState }).ctx.abort(
        "job ended its isolate"
      );
    }
    if (job.id.startsWith("slow")) {
      await new Promise((resolve) => setTimeout(resolve, 6_500));
    }
    this.host
      .sql`INSERT INTO facet_wake_runs (id, at) VALUES (${this.#runId(job.id)}, ${Date.now()})`;
    if (job.id.startsWith("fail")) throw new Error("facet job failed");
  }

  /** A job given up after its attempts: record it, and drop the job. */
  /** A memory-limit seal or back-off for one of this object's jobs. */
  onMemoryLimit(context: {
    sealed: boolean;
    executing?: { id: string };
  }): void {
    if (!context.sealed || !context.executing) return;
    this.host
      .sql`INSERT INTO facet_wake_runs (id, at) VALUES (${`sealed:${context.executing.id}`}, ${Date.now()})`;
  }

  onJobError({ job }: LifecycleJobContext): void {
    this.host
      .sql`INSERT INTO facet_wake_runs (id, at) VALUES (${`gave-up:${job.id}`}, ${Date.now()})`;
  }

  push(id: string, delayMs: number) {
    return this.lifecycle.jobs.push({
      id,
      fn: "run",
      time: Date.now() + delayMs
    });
  }

  cancel(id: string) {
    return this.lifecycle.jobs.cancel(id);
  }

  list() {
    return this.lifecycle.jobs.list().map((job) => job.id);
  }
}

abstract class WakeAgent extends Agent<Cloudflare.Env> {
  /** Make this object's own jobs due, keeping their order. */
  makeJobsDue(): void {
    this
      .sql`UPDATE cf_agents_jobs SET time = time - 120000 WHERE capability = 'facet-wake-probe'`;
  }

  /** Record `count` attempts of job `id` that ended with the isolate. */
  markUnsettled(id: string, count: number): void {
    this.ctx.storage.kv.put(`cf_agents:facet_unsettled:${id}`, count);
  }

  unsettled(id: string): number | undefined {
    return this.ctx.storage.kv.get<number>(`cf_agents:facet_unsettled:${id}`);
  }

  cancelJob(id: string): Promise<boolean> {
    return this.probe.cancel(id);
  }

  /** Recompute this object's wake, as any queue change does. */
  async rearm(): Promise<void> {
    await this.lifecycle.rearmAlarm();
  }

  readonly probe = new WakeProbe(this);
  /** A second instance of the same kind, named. */
  readonly auditProbe = new WakeProbe(this, "audit");

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.lifecycle.use(this.probe).use(this.auditProbe);
  }

  async pushAuditJob(id: string, delayMs: number): Promise<string[]> {
    await this.auditProbe.push(id, delayMs);
    return this.auditProbe.list();
  }

  async pushJob(id: string, delayMs: number): Promise<string[]> {
    await this.probe.push(id, delayMs);
    return this.probe.list();
  }

  ran(): string[] {
    return this.sql<{
      id: string;
    }>`SELECT id FROM facet_wake_runs WHERE id != 'start' ORDER BY at`.map(
      (row) => row.id
    );
  }

  /** When this object started, each time. */
  starts(): number[] {
    return this.sql<{ at: number }>`
      SELECT at FROM facet_wake_runs WHERE id = 'start' ORDER BY at`.map(
      (row) => row.at
    );
  }

  pendingJobs(): string[] {
    return this.probe.list();
  }
}

/** Drive calls into a middle facet that fail before they reach it. */
let failingDrives = 0;
/** Set: a root's alarms do nothing, so a test can read what start left. */
let rootAlarmsHeld = false;

/** Third level: root -> middle -> leaf. */
export class FacetWakeLeaf extends WakeAgent {}

export class FacetWakeMiddle extends WakeAgent {
  syncs = 0;

  /** Count this facet's `storage.sync()` calls from now on. */
  countSyncs(): void {
    const storage = this.ctx.storage;
    const sync = storage.sync.bind(storage);
    storage.sync = () => {
      this.syncs += 1;
      return sync();
    };
  }

  syncCount(): number {
    return this.syncs;
  }

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
  armReports = 0;

  override async _cf_routeLifecycle(
    target: Parameters<Agent["_cf_routeLifecycle"]>[0],
    envelope: Parameters<Agent["_cf_routeLifecycle"]>[1]
  ): Promise<unknown> {
    if ((envelope.payload as { type?: string }).type === "arm") {
      this.armReports += 1;
    }
    return super._cf_routeLifecycle(target, envelope);
  }

  armReportCount(): number {
    return this.armReports;
  }

  async middleRearm(name: string): Promise<void> {
    await (await this.subAgent(FacetWakeMiddle, name)).rearm();
  }

  async middlePush(name: string, id: string, delayMs: number) {
    return (await this.subAgent(FacetWakeMiddle, name)).pushJob(id, delayMs);
  }

  async middleAuditPush(name: string, id: string, delayMs: number) {
    return (await this.subAgent(FacetWakeMiddle, name)).pushAuditJob(
      id,
      delayMs
    );
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

  async middleStarts(name: string): Promise<number[]> {
    return (await this.subAgent(FacetWakeMiddle, name)).starts();
  }

  async middlePending(name: string): Promise<string[]> {
    return (await this.subAgent(FacetWakeMiddle, name)).pendingJobs();
  }

  /** Make every facet wake due now, keeping any unreported drive counts. */
  makeFacetWakesDueKeepingDrives(): void {
    this.sql`UPDATE cf_agents_jobs SET time = ${Date.now() - 1}
      WHERE capability LIKE 'cf:facet-wake:%'`;
  }

  /** Make every facet wake due now and forget unreported drives. */
  makeFacetWakesDue(): void {
    this.makeFacetWakesDueKeepingDrives();
    for (const [key] of this.ctx.storage.kv.list({
      prefix: "cf_agents:facet_drives:"
    })) {
      this.ctx.storage.kv.delete(key);
    }
  }

  setRootJobAttempts(id: string, attempts: number): void {
    this.sql`UPDATE cf_agents_jobs SET attempts = ${attempts} WHERE id = ${id}`;
  }

  rootJobAttempts(id: string): number | null {
    return (
      this.sql<{ attempts: number }>`
        SELECT attempts FROM cf_agents_jobs WHERE id = ${id}
      `[0]?.attempts ?? null
    );
  }

  /** End this root's isolate, and its facets with it. */
  override async alarm(): Promise<void> {
    if (rootAlarmsHeld) return;
    return super.alarm();
  }

  holdRootAlarms(held: boolean): void {
    rootAlarmsHeld = held;
  }

  resetTree(): void {
    this.ctx.abort("test reset");
  }

  async middleCountSyncs(name: string): Promise<void> {
    await (await this.subAgent(FacetWakeMiddle, name)).countSyncs();
  }

  async middleSyncCount(name: string): Promise<number> {
    return (await this.subAgent(FacetWakeMiddle, name)).syncCount();
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
  /** Unreplied drives this root counts for a path, read from the root. */
  unreportedDrives(key: string): number {
    return (
      this.ctx.storage.kv.get<{ count: number }>(
        `cf_agents:facet_drives:${key}`
      )?.count ?? 0
    );
  }

  markUnreportedDrives(key: string, count: number, agoMs = 0): void {
    this.ctx.storage.kv.put(`cf_agents:facet_drives:${key}`, {
      count,
      at: Date.now() - agoMs
    });
  }

  async middleMarkUnsettled(
    name: string,
    id: string,
    count: number
  ): Promise<void> {
    await (await this.subAgent(FacetWakeMiddle, name)).markUnsettled(id, count);
  }

  async middleMakeDue(name: string): Promise<void> {
    await (await this.subAgent(FacetWakeMiddle, name)).makeJobsDue();
  }

  async middleUnsettled(name: string, id: string): Promise<number | undefined> {
    return (await this.subAgent(FacetWakeMiddle, name)).unsettled(id);
  }

  async middleCancel(name: string, id: string): Promise<boolean> {
    return (await this.subAgent(FacetWakeMiddle, name)).cancelJob(id);
  }

  async deleteMiddle(name: string): Promise<void> {
    await this.deleteSubAgent(FacetWakeMiddle, name);
  }

  rootJobs(): { id: string; capability: string; time: number }[] {
    return this.sql<{ id: string; capability: string; time: number }>`
      SELECT id, capability, time FROM cf_agents_jobs ORDER BY time`;
  }

  async setAlarmForTest(time: number): Promise<void> {
    await this.ctx.storage.setAlarm(time);
  }

  async alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}
