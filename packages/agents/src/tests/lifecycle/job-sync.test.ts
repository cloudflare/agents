import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

class SyncJobCapability extends LifecycleCapability {
  constructor() {
    super("sync-job-test");
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.pushSync(options);
  }

  cancel(id: string) {
    return this.lifecycle.jobs.cancelSync(id);
  }

  list() {
    return this.lifecycle.jobs.list();
  }

  rearm() {
    return this.lifecycle.jobs.rearm();
  }
}

describe("Lifecycle synchronous jobs", () => {
  it("rolls a synchronous job back with its surrounding transaction", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const capability = new SyncJobCapability();
      const { lifecycle } = install(capability);
      await lifecycle.start();

      expect(() =>
        storage.transactionSync(() => {
          capability.push({ id: "job", fn: "run", time: Date.now() });
          throw new Error("rollback");
        })
      ).toThrow("rollback");
      expect(capability.list()).toEqual([]);
    });
  });

  it("rearms after a committed synchronous mutation", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const capability = new SyncJobCapability();
      const { lifecycle } = install(capability);
      await lifecycle.start();

      const time = Date.now() + 60_000;
      storage.transactionSync(() => {
        capability.push({ id: "job", fn: "run", time });
      });
      expect(await storage.getAlarm()).toBeNull();

      await capability.rearm();
      expect(await storage.getAlarm()).toBe(time);

      storage.transactionSync(() => {
        expect(capability.cancel("job")).toBe(true);
      });
      await capability.rearm();
      expect(await storage.getAlarm()).toBeNull();
    });
  });
});
