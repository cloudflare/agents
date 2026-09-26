import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Lifecycle synchronous job composition", () => {
  it("commits capability state and its job together", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    await stub.stageProbeJob("committed");
    expect((await stub.probeState()).state).toEqual(["committed"]);

    await runDurableObjectAlarm(stub);
    expect((await stub.probeState()).deliveries).toEqual(["committed"]);
  });

  it("rolls back capability state and its job together", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    expect(await stub.stageProbeJob("rolled-back", true)).toBe(
      "rollback requested"
    );
    expect(await stub.probeState()).toEqual({ state: [], deliveries: [] });

    // The rolled-back transaction lazily created then removed the jobs table.
    // A later sync push must repair the isolate-local table cache.
    expect(await stub.stageProbeJob("after-rollback")).toBeNull();
    await runDurableObjectAlarm(stub);
    expect(await stub.probeState()).toEqual({
      state: ["after-rollback"],
      deliveries: ["after-rollback"]
    });
  });

  it("dispatches a composed job after Durable Object eviction", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    await stub.stageProbeJob("evicted");
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    expect((await stub.probeState()).deliveries).toEqual(["evicted"]);
  });
});
