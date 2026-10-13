import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Lifecycle alarm startup failure", () => {
  it("keeps a wake for queued jobs when startup fails inside the alarm", async () => {
    const stub = env.AlarmStartFailureObject.getByName(crypto.randomUUID());
    await stub.queueJobThenFailStartup(Date.now() + 3_600_000);
    await evictDurableObject(stub);

    // Bring the job due, so the alarm drives it and has to start up. The
    // physical alarm stays an hour out until the test runs it.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ? WHERE id = 'pending'",
        Date.now() - 1
      );
    });
    const before = Date.now();
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      "intentional startup failure"
    );

    const alarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm()
    );
    // Not left to the platform's few alarm retries: a fallback wake stands
    // until startup succeeds again.
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(before + 25_000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 35_000);
  });
});
