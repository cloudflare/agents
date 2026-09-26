import { describe, expect, it } from "vitest";
import { createHarnessStub, waitFor } from "./test-harness";

describe("StateMachine effects", () => {
  it("executes a newly planned effect once", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startEffect("fresh", "safe");

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "effect:fresh" });
    expect(await stub.effectActivity()).toEqual({
      runs: ["fresh"],
      reconciles: []
    });
  });

  it("replays a safe uncertain effect with its durable input", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedEffectRecovery("safe", "safe");

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "effect:safe"
    });
    expect(await stub.effectActivity()).toEqual({
      runs: ["safe"],
      reconciles: []
    });
  });

  it("does not replay a never effect", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedEffectRecovery("unsafe", "never");

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "interrupted"
    });
    expect(await stub.effectActivity()).toEqual({ runs: [], reconciles: [] });
  });

  it("aborts an admitted effect when durable cancellation wins", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startEffect("block", "safe");
    const deadline = Date.now() + 5_000;
    for (;;) {
      const snapshot = await stub.runSnapshot(receipt.runId);
      if (snapshot?.effects?.some((effect) => effect.status === "running"))
        break;
      if (Date.now() > deadline) throw new Error("effect did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await stub.cancelRun(receipt.runId, "cancel effect");
    await expect(
      waitFor(stub, receipt.runId, ["cancelled"])
    ).resolves.toMatchObject({
      error: { message: "cancel effect" }
    });
  });

  it("reconciles a queryable uncertain effect", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedEffectRecovery(
      "ignored",
      "reconcile",
      "done:remote"
    );

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "reconciled:remote"
    });
    expect(await stub.effectActivity()).toEqual({
      runs: [],
      reconciles: ["done:remote"]
    });
  });
});
