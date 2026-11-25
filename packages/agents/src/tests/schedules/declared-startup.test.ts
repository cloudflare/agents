import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { declareSchedules, listDeclaredSchedules } from "../../internal";
import type { SchedulerHarnessObject } from "../capabilities/scheduler";

describe("declared schedules and startup", () => {
  // declare() chains every reconcile, across groups, on one promise, and each
  // reconcile first awaits lifecycle.ready(). A declare() made before startup
  // (a constructor, like Outbox sinks are declared) waits for startup; a
  // declare() made by onStart then waits behind it, and startup never ends.
  it("starts when declare() runs both before startup and in onStart", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SchedulerHarnessObject) => {
      (instance as unknown as { onStart: () => Promise<void> }).onStart =
        async () => {
          await declareSchedules(
            instance.scheduler,
            { lib: { schedule: "every 1 hour", run() {} } },
            { group: "lib" }
          );
        };
      // As a constructor would: not awaited, outside startup.
      const early = declareSchedules(instance.scheduler, {
        app: { schedule: "every 1 hour", run() {} }
      });
      const outcome = await Promise.race([
        instance.lifecycle.start().then(() => "started"),
        new Promise((resolve) => setTimeout(() => resolve("stuck"), 2_000))
      ]);
      expect(outcome).toBe("started");
      await early;
    });
  });

  // The constructor's call waits for startup and so reaches the chain after
  // onStart's later call. It must not undo it.
  it("keeps onStart's declaration over an earlier one made before startup", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SchedulerHarnessObject) => {
      (instance as unknown as { onStart: () => Promise<void> }).onStart =
        async () => {
          await declareSchedules(instance.scheduler, {});
        };
      const early = declareSchedules(instance.scheduler, {
        digest: { schedule: "every 1 hour", run() {} }
      });
      await instance.lifecycle.start();
      await early;
      expect(listDeclaredSchedules(instance.scheduler)).toEqual([]);
    });
  });
});
