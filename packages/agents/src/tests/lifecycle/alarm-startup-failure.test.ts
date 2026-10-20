import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

const HOUR_MS = 3_600_000;

function readAlarm(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.getAlarm()
  );
}

describe("Lifecycle alarm startup failure", () => {
  it("keeps a wake for an overdue job when startup fails inside the alarm", async () => {
    const stub = env.AlarmStartFailureObject.getByName(crypto.randomUUID());
    await stub.queueJobThenFailStartup(Date.now() + HOUR_MS);
    await evictDurableObject(stub);

    // Make the job overdue. The physical alarm stays an hour out, so the
    // platform does not fire it before the test runs it.
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

    // A fallback wake stands whether or not the platform's own alarm retries
    // run, and it is not immediate, so a failing startup cannot spin.
    const alarm = await readAlarm(stub);
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(before + 25_000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 35_000);
  });

  it("keeps a future job's own wake when startup fails inside the alarm", async () => {
    const stub = env.AlarmStartFailureObject.getByName(crypto.randomUUID());
    const time = Date.now() + HOUR_MS;
    await stub.queueJobThenFailStartup(time);
    await evictDurableObject(stub);

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      "intentional startup failure"
    );

    expect(await readAlarm(stub)).toBe(time);
  });
});
