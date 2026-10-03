import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DriverHarnessObject } from "../capabilities/driver";

async function waitForStarted(
  stub: DurableObjectStub<DriverHarnessObject>,
  count: number
): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const started = await stub.started();
    if (started.length >= count) return started;
    if (Date.now() >= deadline) return started;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Driver concurrency", () => {
  it("starts independent scopes without waiting for either step to finish", async () => {
    const stub = env.DriverHarnessObject.getByName(crypto.randomUUID());
    await stub.enableGate();
    await stub.submit("main", "op-1", "first");
    await stub.submit("research", "op-2", "second");

    const alarm = runDurableObjectAlarm(stub);
    const started = await waitForStarted(stub, 2);

    expect(started.sort()).toEqual(["op-1", "op-2"]);
    expect(await stub.pending()).toHaveLength(2);
    const returned = await Promise.race([
      alarm.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
    ]);
    expect(returned).toBe(true);

    await stub.releaseGate();
    await alarm;
    expect(await waitForStarted(stub, 2)).toHaveLength(2);
  });

  it("steps an operation again after an eviction cuts its step off", async () => {
    const name = crypto.randomUUID();
    const stub = env.DriverHarnessObject.getByName(name);
    await stub.enableGate();
    await stub.submit("main", "op-1", "first");
    await runDurableObjectAlarm(stub);
    expect(await waitForStarted(stub, 1)).toEqual(["op-1"]);

    await evictDurableObject(stub);
    const fresh = env.DriverHarnessObject.getByName(name);
    await runDurableObjectAlarm(fresh);

    expect(await fresh.result("op-1")).toEqual({ answer: "op-1" });
    // The step that was cut off ran once; the replay found nothing to
    // resume, so it ran the whole step again.
    expect(await fresh.steps("op-1")).toBe(2);
    expect(await fresh.pending()).toEqual([]);
  });
});
