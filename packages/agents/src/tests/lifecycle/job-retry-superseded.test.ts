import { describe, expect, it } from "vitest";
import { LifecycleCapability } from "../../lifecycle/capability";
import type {
  LifecycleJobOutcome,
  LifecycleJobs
} from "../../lifecycle/job-queue";
import { Queue } from "../../queue";
import { Scheduler } from "../../schedules";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * A due job whose callback throws waits in the job driver's retry backoff
 * (tryN's timer) before its next attempt. Other requests run during that
 * wait. A cancel or a same-id push made then is newer intent, so the next
 * attempt must not run the old job.
 *
 * Each test follows the model's path (JobQueue.tla, verify-runtime):
 * AlarmBegins, Claim, CallbackFails, then Cancel or Push, then Retry.
 */

const RETRY = { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 50 };

function backdate(storage: DurableObjectStorage, id: string): void {
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE id = ?",
    Date.now() - 1_000,
    id
  );
}

/** A callback that throws on its first call and records every call. */
function failsOnce() {
  const calls: unknown[] = [];
  let resolveFailed!: () => void;
  const failed = new Promise<void>((resolve) => {
    resolveFailed = resolve;
  });
  const callback = (payload: unknown) => {
    calls.push(payload);
    if (calls.length === 1) {
      resolveFailed();
      throw new Error("first attempt fails");
    }
  };
  return { calls, failed, callback };
}

describe("job retry after newer intent", () => {
  it("does not run a schedule again once it is cancelled during the retry wait", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const flaky = failsOnce();
      const scheduler = new Scheduler({
        callbacks: { flaky: flaky.callback },
        retry: RETRY
      });
      const { lifecycle } = install(scheduler);
      await lifecycle.start();
      const schedule = await scheduler.set(60, "flaky", "payload");
      backdate(storage, schedule.id);

      // AlarmBegins, Claim, CallbackFails: attempt 1 throws.
      const alarm = lifecycle.alarm();
      await flaky.failed;
      // Cancel: a request cancels the schedule while tryN waits.
      expect(await scheduler.cancel(schedule.id)).toBe(true);
      // Retry: the timer fires.
      await alarm;

      expect(flaky.calls).toEqual(["payload"]);
      expect(await scheduler.list()).toEqual([]);
    });
  });

  it("does not run a queue item again once it is cancelled during the retry wait", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const flaky = failsOnce();
      const queue = new Queue({
        callbacks: { flaky: flaky.callback },
        retry: RETRY
      });
      const { lifecycle } = install(queue);
      await lifecycle.start();
      const item = await queue.push("flaky", "payload");

      const alarm = lifecycle.alarm();
      await flaky.failed;
      expect(await queue.cancel(item.id)).toBe(true);
      await alarm;

      expect(flaky.calls).toEqual(["payload"]);
      expect(await queue.list()).toEqual([]);
    });
  });

  it("runs a queue item replaced during the retry wait only with its new payload", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const flaky = failsOnce();
      const queue = new Queue({
        callbacks: { flaky: flaky.callback },
        retry: RETRY
      });
      const { lifecycle } = install(queue);
      await lifecycle.start();
      await queue.push("flaky", "old", { id: "item" });

      const alarm = lifecycle.alarm();
      await flaky.failed;
      // Push: the same id with a new payload replaces the item.
      await queue.push("flaky", "new", { id: "item" });
      await alarm;
      // The replaced item is still due; the next alarm runs it.
      await lifecycle.alarm();

      expect(flaky.calls).toEqual(["old", "new"]);
      expect(await queue.list()).toEqual([]);
    });
  });

  it("does not run the old payload when an overlapping alarm claims the replacement", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const calls: unknown[] = [];
      let resolveFailed!: () => void;
      const failed = new Promise<void>((resolve) => {
        resolveFailed = resolve;
      });
      let resolveNewStarted!: () => void;
      const newStarted = new Promise<void>((resolve) => {
        resolveNewStarted = resolve;
      });
      let releaseNew!: () => void;
      const newGate = new Promise<void>((resolve) => {
        releaseNew = resolve;
      });
      const queue = new Queue({
        callbacks: {
          work: async (payload: unknown) => {
            calls.push(payload);
            if (payload === "old" && calls.length === 1) {
              resolveFailed();
              throw new Error("first attempt fails");
            }
            if (payload === "new") {
              resolveNewStarted();
              await newGate;
            }
          }
        },
        retry: RETRY
      });
      const { lifecycle } = install(queue);
      await lifecycle.start();
      await queue.push("work", "old", { id: "item" });

      // Alarm A: attempt 1 of "old" throws and A waits to retry.
      const alarmA = lifecycle.alarm();
      await failed;
      // The item is replaced, and alarm B claims the replacement.
      await queue.push("work", "new", { id: "item" });
      const alarmB = lifecycle.alarm();
      await newStarted;
      // A's retry timer fires while B still runs "new".
      await alarmA;
      releaseNew();
      await alarmB;

      expect(calls).toEqual(["old", "new"]);
      expect(await queue.list()).toEqual([]);
    });
  });

  it("keeps a completed job completed when an overlapping alarm's dispatch of it yields", async () => {
    // Alarm A runs the job and holds; alarm B dispatches the same unchanged
    // job and yields (as a routed dispatch does when its owner is
    // unreachable). A then completes: the job is done and must not stay due.
    class Probe extends LifecycleCapability {
      dispatches = 0;
      releaseFirst!: () => void;
      readonly firstStarted: Promise<void>;
      #firstStarted!: () => void;
      constructor() {
        super("probe");
        this.firstStarted = new Promise((resolve) => {
          this.#firstStarted = resolve;
        });
      }
      get queue(): LifecycleJobs {
        return this.lifecycle.jobs;
      }
      async onJob(): Promise<LifecycleJobOutcome> {
        this.dispatches += 1;
        if (this.dispatches > 1) return "yield";
        this.#firstStarted();
        await new Promise<void>((resolve) => {
          this.releaseFirst = resolve;
        });
        return undefined;
      }
    }
    await withCapabilityHarness(async ({ install }) => {
      const probe = new Probe();
      const { lifecycle } = install(probe);
      await lifecycle.start();
      await probe.queue.push({ id: "job", fn: "run", time: Date.now() - 1000 });

      const alarmA = lifecycle.alarm();
      await probe.firstStarted;
      await lifecycle.alarm();
      probe.releaseFirst();
      await alarmA;

      expect(probe.dispatches).toBe(2);
      expect(probe.queue.get("job")).toBeUndefined();
    });
  });
});
