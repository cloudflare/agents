import { describe, expect, it } from "vitest";
import { parentStub } from "./helpers";

describe("DynamicAgents teardown", () => {
  it("abort preserves storage; delete wipes it and the registry", async () => {
    const parent = parentStub(crypto.randomUUID());
    expect(await parent.increment("n")).toBe(1);
    expect(await parent.increment("n")).toBe(2);

    await parent.abort("n");
    expect(await parent.increment("n")).toBe(3);

    await parent.delete("n");
    expect(await parent.has("n")).toBe(false);
    expect(await parent.increment("n")).toBe(1);
  });

  it("delete is idempotent", async () => {
    const parent = parentStub(crypto.randomUUID());
    await parent.delete("never-spawned");
    await parent.spawn("n");
    await parent.delete("n");
    await parent.delete("n");
    expect(await parent.list()).toEqual([]);
  });

  it("a child can delete itself through the root", async () => {
    const parent = parentStub(crypto.randomUUID());
    await parent.increment("self");
    await parent.childDeleteSelf("self");
    expect(await parent.has("self")).toBe(false);
    expect(await parent.increment("self")).toBe(1);
  });

  it("retires root-owned mirrors for the deleted subtree", async () => {
    const parent = parentStub(crypto.randomUUID());
    await parent.childSchedule("n", 3600);
    await parent.childHoldLease("n", "run-1");
    await parent.childKeepAlive("n", "hold");
    expect(await parent.childSchedules("n")).toBe(1);
    expect((await parent.leaseRows()).map((row) => row.id)).toEqual(["run-1"]);
    expect(await parent.keepAliveHolds()).toBe(1);
    const before = await parent.jobs();
    expect(before.some((job) => job.owner === "scheduler")).toBe(true);

    await parent.delete("n");

    const after = await parent.jobs();
    expect(after.some((job) => job.owner === "scheduler")).toBe(false);
    expect(await parent.leaseRows()).toEqual([]);
    expect(await parent.keepAliveHolds()).toBe(0);
    expect(after.some((job) => job.owner === "dynamic-agents")).toBe(false);
  });
});
