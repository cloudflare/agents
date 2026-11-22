import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

class Jobs extends LifecycleCapability {
  constructor() {
    super("wake-check-probe");
  }

  onJob(): void {}

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }
}

describe("Lifecycle wake check", () => {
  it("re-arms a lost alarm when the object starts with pending jobs", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const first = install(new Jobs());
      await first.lifecycle.start();
      const time = Date.now() + 60_000;
      await first.capability.push({ id: "pending", fn: "tick", time });
      expect(await storage.getAlarm()).toBe(time);

      // The alarm is lost: the platform dropped it after its retries, or
      // user code deleted it.
      await storage.deleteAlarm();

      // A later wake (a fresh isolate) starts a new Lifecycle on the same
      // storage and must restore the wake for the pending job.
      const second = install(new Jobs());
      await second.lifecycle.start();
      expect(await storage.getAlarm()).toBe(time);
    });
  });

  it("leaves an existing alarm alone on start", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const first = install(new Jobs());
      await first.lifecycle.start();
      const time = Date.now() + 60_000;
      await first.capability.push({ id: "pending", fn: "tick", time });
      // Another owner's earlier wake (or a deadman) stands.
      const earlier = Date.now() + 30_000;
      await storage.setAlarm(earlier);

      const second = install(new Jobs());
      await second.lifecycle.start();
      expect(await storage.getAlarm()).toBe(earlier);
    });
  });
});
