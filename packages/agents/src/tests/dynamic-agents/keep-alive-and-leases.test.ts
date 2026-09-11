import { describe, expect, it } from "vitest";
import { parentStub } from "./helpers";

describe("DynamicAgents keep-alive and leases", () => {
  it("holds the root's heartbeat for a child until released", async () => {
    const parent = parentStub(crypto.randomUUID());
    expect(await parent.alarmTime()).toBeNull();

    await parent.childKeepAlive("n", "hold");
    expect(await parent.keepAliveHolds()).toBe(1);
    expect(
      (await parent.jobs()).some(
        (job) => job.owner === "dynamic-agents" && job.fn === "keep-alive"
      )
    ).toBe(true);
    expect(await parent.alarmTime()).not.toBeNull();

    await parent.childKeepAlive("n", "release");
    expect(await parent.keepAliveHolds()).toBe(0);
    expect((await parent.jobs()).some((job) => job.fn === "keep-alive")).toBe(
      false
    );
  });

  it("sweeps leases through the leased child and prunes released ones", async () => {
    const parent = parentStub(crypto.randomUUID());
    await parent.childHoldLease("n", "run-1");
    expect(await parent.leaseRows()).toEqual([
      { owner: expect.stringContaining("DynamicChildObject:n"), id: "run-1" }
    ]);
    expect((await parent.jobs()).some((job) => job.fn === "lease-sweep")).toBe(
      true
    );

    // The child still holds the lease: the sweep asks it and keeps the row.
    await parent.sweepLeases();
    expect(await parent.childLeaseChecks("n")).toBe(1);
    expect((await parent.leaseRows()).length).toBe(1);

    await parent.childReleaseLease("n", "run-1");
    expect(await parent.leaseRows()).toEqual([]);
    expect((await parent.jobs()).some((job) => job.fn === "lease-sweep")).toBe(
      false
    );
  });

  it("prunes a lease whose child reports nothing left", async () => {
    const parent = parentStub(crypto.randomUUID());
    await parent.childHoldLease("n", "run-1");
    // Abort loses the child's in-memory held set; the row on the root stays
    // until a sweep asks the (restarted) child, which reports zero.
    await parent.abort("n");
    await parent.sweepLeases();
    expect(await parent.leaseRows()).toEqual([]);
  });
});
