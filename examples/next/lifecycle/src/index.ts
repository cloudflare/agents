import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";

/** Identifies one in-memory instance; changes on every restart/reset. */
let ISOLATE_ID = "";
let BOOTED_AT = "";
function isolateId(): string {
  if (!ISOLATE_ID) {
    ISOLATE_ID = crypto.randomUUID().slice(0, 8);
    BOOTED_AT = new Date().toISOString();
  }
  return ISOLATE_ID;
}

type WakeRow = {
  at: string;
  isolate: string;
  event: string;
  detail: string;
};

/**
 * Demo capability: durable jobs that tick, crash, and OOM on purpose so the
 * Lifecycle job queue's restart recovery, deadman, and memory-limit circuit
 * breaker are observable on a deployed Durable Object.
 */
class JobDemo extends LifecycleCapability {
  constructor() {
    super("job-demo");
  }

  onStart(): void {
    this.lifecycle.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS demo_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        isolate TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
    this.log("start", `lifecycle startup on isolate ${isolateId()}`);
  }

  log(event: string, detail: string): void {
    this.lifecycle.storage.sql.exec(
      "INSERT INTO demo_log (at, isolate, event, detail) VALUES (?, ?, ?, ?)",
      new Date().toISOString(),
      isolateId(),
      event,
      detail
    );
    this.lifecycle.storage.sql.exec(
      "DELETE FROM demo_log WHERE seq <= (SELECT MAX(seq) FROM demo_log) - 60"
    );
  }

  bump(name: string): number {
    this.lifecycle.storage.sql.exec(
      `INSERT INTO demo_counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`,
      name
    );
    const rows = [
      ...this.lifecycle.storage.sql.exec<{ value: number }>(
        "SELECT value FROM demo_counters WHERE name = ?",
        name
      )
    ];
    return rows[0]?.value ?? 0;
  }

  async startTicking(intervalSeconds: number): Promise<void> {
    await this.lifecycle.jobs.push({
      id: "tick",
      fn: "tick",
      time: Date.now(),
      payload: { intervalSeconds }
    });
    this.log("push", `tick job pushed (every ${intervalSeconds}s)`);
  }

  async stopTicking(): Promise<boolean> {
    const cancelled = await this.lifecycle.jobs.cancel("tick");
    this.log("cancel", `tick job ${cancelled ? "cancelled" : "not found"}`);
    return cancelled;
  }

  /** Push a job whose dispatch throws the platform memory-limit error. */
  async pushOomJob(): Promise<void> {
    await this.lifecycle.jobs.push({
      id: "boom",
      fn: "boom",
      time: Date.now(),
      // One in-process attempt so every alarm invocation is one clean strike.
      retry: { maxAttempts: 1 }
    });
    this.log("push", "boom job pushed (throws a memory-limit reset)");
  }

  /** Push a job that REALLY exhausts isolate memory for its first two runs. */
  async pushRealOomJob(): Promise<void> {
    this.lifecycle.storage.sql.exec(
      "DELETE FROM demo_counters WHERE name = 'real-oom-runs'"
    );
    await this.lifecycle.jobs.push({
      id: "real-oom",
      fn: "realOom",
      time: Date.now(),
      retry: { maxAttempts: 1 }
    });
    this.log("push", "real-oom job pushed (allocates until the isolate dies)");
  }

  onJob({ job }: LifecycleJobContext): LifecycleJobOutcome {
    switch (job.fn) {
      case "tick": {
        const count = this.bump("ticks");
        this.log("tick", `tick #${count} ran on isolate ${isolateId()}`);
        const intervalSeconds =
          (job.payload as { intervalSeconds?: number })?.intervalSeconds ?? 5;
        return { rescheduleAt: Date.now() + intervalSeconds * 1000 };
      }
      case "boom": {
        const attempt = this.bump("boom-attempts");
        this.log(
          "boom",
          `boom attempt #${attempt}: throwing memory-limit reset`
        );
        throw new Error(
          "Durable Object's isolate exceeded its memory limit and was reset."
        );
      }
      case "realOom": {
        const runs = this.bump("real-oom-runs");
        if (runs <= 2) {
          this.log(
            "real-oom",
            `run #${runs}: allocating until the isolate dies`
          );
          const hog: number[][] = [];
          for (;;) {
            hog.push(new Array(1_000_000).fill(runs));
          }
        }
        this.log("real-oom", `run #${runs}: survived, completing the job`);
        return undefined;
      }
      default:
        this.log("job", `unknown fn ${job.fn}`);
        return undefined;
    }
  }

  async status() {
    const counters = Object.fromEntries(
      [
        ...this.lifecycle.storage.sql.exec<{ name: string; value: number }>(
          "SELECT name, value FROM demo_counters"
        )
      ].map((row) => [row.name, row.value])
    );
    const log = [
      ...this.lifecycle.storage.sql.exec<WakeRow>(
        "SELECT at, isolate, event, detail FROM demo_log ORDER BY seq DESC LIMIT 25"
      )
    ];
    const strikes = await this.lifecycle.storage.get<number>(
      "cf_agents:oom_alarm_strikes"
    );
    return {
      isolate: { id: isolateId(), bootedAt: BOOTED_AT },
      oomStrikes: strikes ?? 0,
      counters,
      jobs: this.lifecycle.jobs.list().map((job) => ({
        id: job.id,
        fn: job.fn,
        dueInMs: job.time - Date.now(),
        retry: job.retry
      })),
      alarm: await this.lifecycle.storage.getAlarm(),
      log
    };
  }
}

/** A plain Durable Object composed with the Agents lifecycle job queue. */
export class DoAgent extends DurableObject<Env> {
  private readonly demo = new JobDemo();
  readonly lifecycle = Lifecycle.install(this).use(this.demo);

  onAlarm(): void {
    // Runs once per alarm invocation, after due jobs are driven.
  }

  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const route = path.slice(path.lastIndexOf("/"));
    switch (route) {
      case "/start": {
        await this.demo.startTicking(5);
        return Response.json({ ok: true, action: "ticking every 5s" });
      }
      case "/stop":
        return Response.json({ ok: await this.demo.stopTicking() });
      case "/restart": {
        this.demo.log("restart", "ctx.abort() requested via /restart");
        // Yield first so this response is delivered before the reset lands.
        setTimeout(() => this.ctx.abort("demo restart"), 100);
        return Response.json({ ok: true, action: "aborting instance" });
      }
      case "/oom": {
        await this.demo.pushOomJob();
        return Response.json({ ok: true, action: "boom job queued" });
      }
      case "/oom-real": {
        await this.demo.pushRealOomJob();
        return Response.json({ ok: true, action: "real OOM job queued" });
      }
      default:
        return Response.json(await this.demo.status());
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        "Job-queue demo. Routes under /agents/do-agent/<name>: /status /start /stop /restart /oom /oom-real",
        { status: 404 }
      )
    );
  }
} satisfies ExportedHandler<Env>;
