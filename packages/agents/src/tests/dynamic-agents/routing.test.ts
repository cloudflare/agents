import { describe, expect, it } from "vitest";
import { parentStub, waitFor } from "./helpers";

/**
 * Routed capabilities on a child reach the root through the transport
 * DynamicAgents provides, and the root reaches the child back.
 */
describe("DynamicAgents route transport", () => {
  it("routes a child's schedules to the root and dispatches them back", async () => {
    const parent = parentStub(crypto.randomUUID());
    const id = await parent.childSchedule("n", 0);
    expect(id).toBeTruthy();
    expect(await parent.childSchedules("n")).toBeGreaterThanOrEqual(0);

    // The due schedule lives on the root; its alarm dispatches into the child.
    await waitFor(
      () => parent.childTicks("n"),
      (ticks) => ticks === 1,
      10_000
    );
    expect(await parent.childSchedules("n")).toBe(0);
  });

  it("lists a child's pending schedules from the root", async () => {
    const parent = parentStub(crypto.randomUUID());
    await parent.childSchedule("n", 3600);
    await parent.childSchedule("n", 7200);
    expect(await parent.childSchedules("n")).toBe(2);
    expect(
      (await parent.jobs()).filter((job) => job.owner === "scheduler").length
    ).toBe(2);
  });
});
