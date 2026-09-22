import { describe, expect, it } from "vitest";
import { createHarnessStub, waitFor } from "./test-harness";

describe("StateMachine local children", () => {
  it("spawns and joins an attached child", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("work", "attached");

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "child:work" });
  });

  it("does not lose a child that settles before the parent joins", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("early", "attached");

    const completed = await waitFor(stub, receipt.runId, ["completed"]);
    expect(completed.result).toBe("child:early");
    expect(completed.revision).toBeGreaterThanOrEqual(2);
  });

  it("cascades cancellation to an attached child", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("slow", "attached");
    let childRunId: string | undefined;
    const deadline = Date.now() + 5_000;
    while (!childRunId) {
      childRunId = (await stub.runSnapshot(receipt.runId))?.children?.[0]
        ?.runId;
      if (Date.now() > deadline) throw new Error("child was not spawned");
      if (!childRunId) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await stub.cancelRun(receipt.runId, "cancel tree");
    await expect(
      waitFor(stub, receipt.runId, ["cancelled"])
    ).resolves.toBeTruthy();
    await expect(
      waitFor(stub, childRunId, ["cancelled"])
    ).resolves.toBeTruthy();
  });

  it("records a background child independently from its result delivery", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("background", "background");

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "child:background" });
  });

  it("does not cancel a background child with its parent", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("slow", "background");
    let childRunId: string | undefined;
    const deadline = Date.now() + 5_000;
    while (!childRunId) {
      childRunId = (await stub.runSnapshot(receipt.runId))?.children?.[0]
        ?.runId;
      if (Date.now() > deadline) throw new Error("child was not spawned");
      if (!childRunId) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await stub.cancelRun(receipt.runId, "cancel parent only");
    await waitFor(stub, receipt.runId, ["cancelled"]);
    await expect(
      waitFor(stub, childRunId, ["completed"])
    ).resolves.toMatchObject({
      result: "child:slow"
    });
  });
});
