import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { Queue } from "../../queue";
import { withCapabilityHarness } from "../shared/capability-harness";

/** Records every dispatch and every terminal failure it is told about. */
class Jobs extends LifecycleCapability {
  readonly attempts: number[] = [];
  readonly failures: { attempt: number; name: string }[] = [];
  failWith: (() => Error) | undefined;

  constructor() {
    super("attempts-probe");
  }

  onJob({ attempt }: LifecycleJobContext): void {
    this.attempts.push(attempt);
    if (this.failWith) throw this.failWith();
  }

  onJobError({ attempt }: LifecycleJobContext, error: unknown): void {
    this.failures.push({
      attempt,
      name: error instanceof Error ? error.name : String(error)
    });
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }

  get(id: string) {
    return this.lifecycle.jobs.get(id);
  }

  cancel(id: string) {
    return this.lifecycle.jobs.cancel(id);
  }
}

/** An owner with no onJobError: its job is its only wake. */
class WakeOnly extends LifecycleCapability {
  readonly attempts: number[] = [];
  timeSeen: number | undefined;

  constructor() {
    super("wake-only-probe");
  }

  onJob({ attempt }: LifecycleJobContext): void {
    this.attempts.push(attempt);
    this.timeSeen = this.lifecycle.jobs.get("wake")?.time;
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }
}

const QUICK = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };

/**
 * Stand in for attempts that ended with their isolate (CPU or wall-time
 * limit, reset): each was counted before it ran, and nothing reported back.
 * The deployed-Worker version of this is in RUNTIME-FACTS (22 Nov).
 */
function interrupted(storage: DurableObjectStorage, id: string, n: number) {
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET attempts = ?, time = ? WHERE id = ?",
    n,
    Date.now() - 1_000,
    id
  );
}

describe("durable job attempts", () => {
  it("continues the count after attempts that ended with their isolate", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      await jobs.push({ id: "job", fn: "run", time: Date.now() + 60_000 });
      interrupted(storage, "job", 1);

      await lifecycle.alarm();

      expect(jobs.attempts).toEqual([2]);
      expect(jobs.get("job")).toBeUndefined();
    });
  });

  it("stops running a job whose every attempt ended with its isolate", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      await jobs.push({
        id: "job",
        fn: "run",
        time: Date.now() + 60_000,
        retry: QUICK
      });
      interrupted(storage, "job", 3);

      await lifecycle.alarm();

      expect(jobs.attempts).toEqual([]);
      expect(jobs.failures).toEqual([
        { attempt: 3, name: "JobAttemptsExhaustedError" }
      ]);
      expect(jobs.get("job")).toBeUndefined();
    });
  });

  it("keeps the job of an owner without onJobError and backs it off", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new WakeOnly();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      await jobs.push({
        id: "wake",
        fn: "scan",
        time: Date.now() + 60_000,
        retry: QUICK
      });
      interrupted(storage, "wake", 3);
      const before = Date.now();

      await lifecycle.alarm();

      // It ran once more, and before it ran its next wake had moved out, so
      // another isolate death would not bring it back for 30 s.
      expect(jobs.attempts).toEqual([4]);
      expect(jobs.timeSeen).toBeGreaterThanOrEqual(before + 30_000);
    });
  });

  it("gives a one-attempt job more than one unreported attempt", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      // A deploy that resets the isolate mid-attempt also leaves the attempt
      // unreported. A one-shot with maxAttempts 1 must still run again.
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      await jobs.push({
        id: "job",
        fn: "run",
        time: Date.now() + 60_000,
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }
      });
      interrupted(storage, "job", 2);

      await lifecycle.alarm();

      expect(jobs.attempts).toEqual([3]);
      expect(jobs.failures).toEqual([]);
    });
  });

  it("keeps the in-invocation retry budget when a platform error comes first", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      const errors = [
        Object.assign(new Error("Network connection lost."), {
          retryable: true
        }),
        new Error("application failure"),
        new Error("application failure")
      ];
      jobs.failWith = () => errors.shift() ?? new Error("application failure");
      await jobs.push({
        id: "job",
        fn: "run",
        time: Date.now() + 60_000,
        retry: QUICK
      });
      interrupted(storage, "job", 1);

      await lifecycle.alarm();

      // Three tries in this invocation, numbered after the one unreported
      // attempt, then the owner hears of the last application error.
      expect(jobs.attempts).toEqual([2, 3, 4]);
      expect(jobs.failures).toEqual([{ attempt: 4, name: "Error" }]);
    });
  });

  it("does not start a job cancelled while its attempt count is written", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      const now = Date.now();
      await jobs.push({ id: "a", fn: "run", time: now - 2 });
      await jobs.push({ id: "b", fn: "run", time: now - 1 });
      const ran: string[] = [];
      jobs.onJob = ({ job }: LifecycleJobContext) => {
        ran.push(job.id);
        // Runs during b's write wait: the timer is set before b's.
        if (job.id === "a") {
          setTimeout(() => void jobs.cancel("b"), 0);
        }
      };

      await lifecycle.alarm();

      expect(ran).toEqual(["a"]);
      expect(jobs.get("b")).toBeUndefined();
    });
  });

  it("gives an exhausted job without onJobError one try per wake", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new WakeOnly();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      let calls = 0;
      jobs.onJob = () => {
        calls += 1;
        throw new Error("still failing");
      };
      await jobs.push({
        id: "wake",
        fn: "scan",
        time: Date.now() + 60_000,
        retry: QUICK
      });
      interrupted(storage, "wake", 3);

      await lifecycle.alarm();

      // No in-alarm retries: the backoff spaces its attempts.
      expect(calls).toBe(1);
    });
  });

  it("counts an attempt in storage before onJob runs", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      let seen: unknown;
      jobs.onJob = () => {
        seen = [
          ...storage.sql.exec(
            "SELECT attempts FROM cf_agents_jobs WHERE id = 'job'"
          )
        ][0]?.attempts;
      };
      await jobs.push({ id: "job", fn: "run", time: Date.now() - 1 });

      await lifecycle.alarm();

      expect(seen).toBe(1);
    });
  });

  it("does not count an attempt that ended in a platform failure", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      jobs.failWith = () =>
        Object.assign(new Error("Network connection lost."), {
          retryable: true
        });
      await jobs.push({
        id: "job",
        fn: "run",
        time: Date.now() - 1,
        retry: QUICK
      });

      await expect(lifecycle.alarm()).rejects.toThrow("connection lost");

      const [row] = [
        ...storage.sql.exec(
          "SELECT attempts FROM cf_agents_jobs WHERE id = 'job'"
        )
      ];
      expect(row?.attempts).toBe(0);
      expect(jobs.failures).toEqual([]);
    });
  });

  it("starts the count again when the job is pushed again", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      await jobs.push({ id: "job", fn: "run", time: Date.now() + 60_000 });
      interrupted(storage, "job", 2);
      await jobs.push({ id: "job", fn: "run", time: Date.now() - 1 });

      await lifecycle.alarm();

      expect(jobs.attempts).toEqual([1]);
    });
  });

  it("adds the attempts column to a queue table from before it existed", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      storage.sql.exec(`
        CREATE TABLE cf_agents_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          capability TEXT NOT NULL,
          fn TEXT NOT NULL,
          time INTEGER NOT NULL,
          payload TEXT,
          retry_options TEXT,
          singleflight INTEGER NOT NULL DEFAULT 0,
          hung_timeout_seconds INTEGER,
          exclusive INTEGER NOT NULL DEFAULT 0,
          recovery_loop INTEGER NOT NULL DEFAULT 0,
          running INTEGER NOT NULL DEFAULT 0,
          execution_started_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        ) WITHOUT ROWID`);
      storage.sql.exec(
        `INSERT INTO cf_agents_jobs (id, capability, fn, time)
         VALUES ('old', 'attempts-probe', 'run', ?)`,
        Date.now() - 1
      );
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();

      await lifecycle.alarm();

      expect(jobs.attempts).toEqual([1]);
      expect(jobs.get("old")).toBeUndefined();
    });
  });
});

describe("Queue items whose attempts ended with their isolate", () => {
  it("drops the item as a terminal failure and says why", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const calls: unknown[] = [];
      const errors: unknown[] = [];
      const queue = new Queue({
        callbacks: { work: (payload: unknown) => void calls.push(payload) },
        onError: (error) => void errors.push(error)
      });
      const { lifecycle } = install(queue);
      await lifecycle.start();
      const item = await queue.push("work", "payload");
      // Three attempts that each took the isolate down: a CPU-limit callback
      // or three resets landing mid-callback look the same from here.
      interrupted(storage, item.id, 3);

      await lifecycle.alarm();

      expect(calls).toEqual([]);
      expect(errors).toMatchObject([{ name: "JobAttemptsExhaustedError" }]);
      expect(await queue.list()).toEqual([]);
    });
  });
});
