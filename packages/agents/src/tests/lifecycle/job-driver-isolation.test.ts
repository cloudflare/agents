import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { Queue } from "../../queue";
import { withCapabilityHarness } from "../shared/capability-harness";

/** An error the platform marks retryable, as a failing downstream stub does. */
function retryableError(): Error {
  return Object.assign(new Error("downstream object is restarting"), {
    retryable: true
  });
}

/** Runs `fn` as a job; `poison` jobs always fail with a platform-class error. */
class Jobs extends LifecycleCapability {
  constructor(
    id: string,
    readonly ran: string[]
  ) {
    super(id);
  }

  onJob({ job }: LifecycleJobContext): void {
    this.ran.push(job.id);
    if (job.fn === "poison") throw retryableError();
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }

  get(id: string) {
    return this.lifecycle.jobs.get(id);
  }
}

const QUICK = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };

describe("job driver isolation", () => {
  it("runs other owners' due jobs when one fails with a platform-class error", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const ran: string[] = [];
      const failing = new Jobs("isolation-failing", ran);
      const other = new Jobs("isolation-other", ran);
      const { lifecycle } = install(failing);
      lifecycle.use(other);
      await lifecycle.start();
      const now = Date.now();
      await failing.push({
        id: "poison",
        fn: "poison",
        time: now - 2_000,
        retry: QUICK
      });
      await other.push({ id: "next", fn: "ok", time: now - 1_000 });

      // The alarm still fails, so the platform sees the failure, but only
      // after the other owner's job had its turn.
      await expect(lifecycle.alarm()).rejects.toThrow("restarting");

      expect(ran).toEqual(["poison", "next"]);
      expect(other.get("next")).toBeUndefined();
    });
  });

  it("holds back the failing owner's later jobs, in order, for the deferral", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const ran: string[] = [];
      const jobs = new Jobs("isolation-failing", ran);
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      const now = Date.now();
      await jobs.push({
        id: "first",
        fn: "poison",
        time: now - 2_000,
        retry: QUICK
      });
      await jobs.push({ id: "second", fn: "ok", time: now - 1_000 });

      await expect(lifecycle.alarm()).rejects.toThrow("restarting");

      // The owner's order holds: the job behind the failing one waits, and
      // both keep their times.
      expect(ran).toEqual(["first"]);
      expect(jobs.get("first")?.time).toBe(now - 2_000);
      expect(jobs.get("second")?.time).toBe(now - 1_000);
      // The next wake is the deferral's end, not an immediate re-fire.
      const alarm = await storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(now + 25_000);
    });
  });

  it("keeps a Queue's order when its head item is deferred", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const calls: string[] = [];
      let failNext = true;
      const queue = new Queue({
        callbacks: {
          create: () => {
            calls.push("create");
            if (failNext) {
              failNext = false;
              throw retryableError();
            }
          },
          update: () => void calls.push("update")
        },
        retry: QUICK
      });
      const { lifecycle } = install(queue);
      await lifecycle.start();
      await queue.push("create", null);
      await queue.push("update", null);

      await expect(lifecycle.alarm()).rejects.toThrow("restarting");
      expect(calls).toEqual(["create"]);
      expect((await queue.list()).map((item) => item.callback)).toEqual([
        "create",
        "update"
      ]);

      // Inside the hold an early alarm runs nothing of this Queue.
      await lifecycle.alarm();
      expect(calls).toEqual(["create"]);

      // After the hold (here: a fresh isolate, which forgets it) the head
      // item runs first again, then the one behind it.
      const later = new Queue({
        callbacks: {
          create: () => void calls.push("create"),
          update: () => void calls.push("update")
        },
        retry: QUICK
      });
      const fresh = install(later).lifecycle;
      await fresh.start();
      await fresh.alarm();
      expect(calls).toEqual(["create", "create", "update"]);
    });
  });
});

describe("job driver deferral", () => {
  it("keeps holding the failing owner when another owner's alarm comes first", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const ran: string[] = [];
      const failing = new Jobs("isolation-failing", ran);
      const other = new Jobs("isolation-other", ran);
      const { lifecycle } = install(failing);
      lifecycle.use(other);
      await lifecycle.start();
      const now = Date.now();
      await failing.push({
        id: "poison",
        fn: "poison",
        time: now - 2_000,
        retry: QUICK
      });

      await expect(lifecycle.alarm()).rejects.toThrow("restarting");
      // Another owner's job becomes due inside the hold.
      await other.push({ id: "later", fn: "ok", time: Date.now() - 1 });
      await lifecycle.alarm();

      expect(ran).toEqual(["poison", "later"]);
    });
  });
});
