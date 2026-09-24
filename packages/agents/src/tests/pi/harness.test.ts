import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

describe("PiHarness", () => {
  it("drives a Pi tool turn through the shared driver", async () => {
    const stub = env.PiDriverHarnessObject.getByName(crypto.randomUUID());
    const receipt = await stub.submitMultiply("main", "op-1", 4);
    expect(receipt).toEqual({
      operationId: "op-1",
      lane: "main",
      accepted: true
    });

    await runDurableObjectAlarm(stub);

    expect(await stub.result("main", "op-1")).toMatchObject({
      operationId: "op-1",
      status: "completed"
    });
    expect(await stub.messages("main")).toEqual([
      "multiply 4",
      "",
      "",
      "complete"
    ]);
    expect(await stub.pending("main")).toEqual([]);
  });

  it("closes the durable stream when queued work is cancelled", async () => {
    const stub = env.PiDriverHarnessObject.getByName(crypto.randomUUID());
    await stub.submitMultiply("main", "op-cancelled", 5);

    expect(await stub.abort("main", "op-cancelled")).toEqual({
      operationId: "op-cancelled",
      newlyRequested: true
    });

    expect(await stub.pending("main")).toEqual([]);
    expect(await stub.streamStatus("main", "op-cancelled")).toMatchObject({
      state: "completed"
    });
    expect(await stub.streamEvents("main", "op-cancelled")).toMatchObject([
      {
        type: "operation_end",
        operationId: "op-cancelled",
        status: "declined"
      }
    ]);
  });

  it("rejoins one foreground durable tool run after eviction", async () => {
    const name = crypto.randomUUID();
    const stub = env.PiDriverHarnessObject.getByName(name);
    await stub.holdDurableTools();
    await stub.submitDurableMultiply("main", "op-durable", 5);

    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(await stub.durableToolStarts()).toBe(1);

    await evictDurableObject(stub);
    const fresh = env.PiDriverHarnessObject.getByName(name);
    await fresh.completeDurableTool();
    for (let index = 0; index < 4; index += 1) {
      await runDurableObjectAlarm(fresh);
    }

    expect(await fresh.durableToolStarts()).toBe(1);
    expect(await fresh.result("main", "op-durable")).toMatchObject({
      status: "completed"
    });
    expect(await fresh.pending("main")).toEqual([]);
  });

  it("recovers a submitted turn after eviction", async () => {
    const name = crypto.randomUUID();
    const stub = env.PiDriverHarnessObject.getByName(name);
    await stub.submitMultiply("main", "op-evicted", 5);

    await evictDurableObject(stub);
    const fresh = env.PiDriverHarnessObject.getByName(name);
    await runDurableObjectAlarm(fresh);

    expect(await fresh.result("main", "op-evicted")).toMatchObject({
      operationId: "op-evicted",
      status: "completed"
    });
    expect(await fresh.messages("main")).toEqual([
      "multiply 5",
      "",
      "",
      "complete"
    ]);
    expect(await fresh.pending("main")).toEqual([]);
    expect(await fresh.streamStatus("main", "op-evicted")).toMatchObject({
      state: "completed"
    });
    const events = (await fresh.streamEvents("main", "op-evicted")) as Array<{
      type: string;
    }>;
    expect(
      events.filter((event) => event.type === "operation_start")
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "operation_end")
    ).toHaveLength(1);
  });

  it("overlaps real provider waits across two lanes", async () => {
    const stub = env.PiDriverHarnessObject.getByName(crypto.randomUUID());
    await stub.holdProviders();
    await stub.submitMultiply("main", "op-main", 2);
    await stub.submitMultiply("research", "op-research", 3);

    const alarm = runDurableObjectAlarm(stub);
    await vi.waitFor(async () => {
      expect((await stub.providerStats()).active).toBe(2);
    });

    expect((await stub.providerStats()).maxActive).toBe(2);
    await stub.releaseProviders();
    await alarm;
    for (let index = 0; index < 3; index += 1) {
      await runDurableObjectAlarm(stub);
    }

    expect(await stub.result("main", "op-main")).toMatchObject({
      status: "completed"
    });
    expect(await stub.result("research", "op-research")).toMatchObject({
      status: "completed"
    });
  });

  it("drives multiple lanes independently and preserves FIFO within a lane", async () => {
    const stub = env.PiDriverHarnessObject.getByName(crypto.randomUUID());
    await stub.submitMultiply("main", "op-1", 2);
    await stub.submitMultiply("main", "op-2", 3);
    await stub.submitMultiply("research", "op-3", 4);

    for (let i = 0; i < 4; i++) await runDurableObjectAlarm(stub);

    expect(await stub.result("main", "op-1")).toMatchObject({
      status: "completed"
    });
    expect(await stub.result("main", "op-2")).toMatchObject({
      status: "completed"
    });
    expect(await stub.result("research", "op-3")).toMatchObject({
      status: "completed"
    });
    expect(await stub.messages("main")).toEqual([
      "multiply 2",
      "",
      "",
      "complete",
      "multiply 3",
      "",
      "",
      "complete"
    ]);
    expect(await stub.pending("main")).toEqual([]);
    expect(await stub.pending("research")).toEqual([]);
  });
});
