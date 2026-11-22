import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

/** An error the platform marks retryable, as a failing downstream stub does. */
function retryableError(): Error {
  return Object.assign(new Error("downstream object is restarting"), {
    retryable: true
  });
}

/** Runs `fn` as a job; `poison` jobs always fail with a platform-class error. */
class Jobs extends LifecycleCapability {
  readonly ran: string[] = [];

  constructor() {
    super("isolation-probe");
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
  it("runs the other due jobs when one fails with a platform-class error", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      const now = Date.now();
      await jobs.push({
        id: "poison",
        fn: "poison",
        time: now - 2_000,
        retry: QUICK
      });
      await jobs.push({ id: "next", fn: "ok", time: now - 1_000 });

      // The alarm still fails, so the platform and the memory-limit breaker
      // see the failure, but only after every due job had its turn.
      await expect(lifecycle.alarm()).rejects.toThrow("restarting");

      expect(jobs.ran).toEqual(["poison", "next"]);
      expect(jobs.get("next")).toBeUndefined();
    });
  });

  it("does not put a failing job back at the head of the queue", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const jobs = new Jobs();
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      const before = Date.now();
      await jobs.push({
        id: "poison",
        fn: "poison",
        time: before - 2_000,
        retry: QUICK
      });

      await expect(lifecycle.alarm()).rejects.toThrow("restarting");

      // Kept, and backed off rather than due again at once.
      const job = jobs.get("poison");
      expect(job).toBeDefined();
      expect(job!.time).toBeGreaterThan(before);
    });
  });
});
