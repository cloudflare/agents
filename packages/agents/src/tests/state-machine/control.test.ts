import { describe, expect, it } from "vitest";
import { createHarnessStub, waitFor } from "./test-harness";

describe("StateMachine control", () => {
  it("cancels a parked run durably", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("cancel");
    await waitFor(stub, receipt.runId, ["waiting"]);

    expect(await stub.cancelRun(receipt.runId, "stopped")).toEqual({
      status: "requested"
    });
    await expect(
      waitFor(stub, receipt.runId, ["cancelled"])
    ).resolves.toMatchObject({
      error: { name: "Cancelled", message: "stopped" }
    });
    expect(await stub.cancelRun(receipt.runId)).toEqual({ status: "terminal" });
  });

  it("lets a machine handle cancellation with a final transition", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startGracefulCancel("graceful");
    await waitFor(stub, receipt.runId, ["waiting"]);

    await stub.cancelRun(receipt.runId, "handled");
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "cancel-handled" });
  });

  it("deletes a terminal run and rejects late events", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("delete");
    await stub.sendMessage(receipt.runId, "delete", "done", "delete-event");
    await waitFor(stub, receipt.runId, ["completed"]);

    expect(await stub.deleteRun(receipt.runId)).toBe(true);
    expect(await stub.runSnapshot(receipt.runId)).toBeNull();
    expect(
      await stub.sendMessage(receipt.runId, "delete", "late", "late-event")
    ).toEqual({ status: "not-found" });
  });

  it("pauses without changing the checkpoint and resumes later", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("pause");
    const waiting = await waitFor(stub, receipt.runId, ["waiting"]);

    expect(await stub.pauseRun(receipt.runId)).toBe(true);
    const paused = await waitFor(stub, receipt.runId, ["paused"]);
    expect(paused.revision).toBe(waiting.revision);

    await stub.sendMessage(receipt.runId, "pause", "resumed", "pause-event");
    expect((await stub.runSnapshot(receipt.runId))?.status).toBe("paused");
    expect(await stub.resumeRun(receipt.runId)).toBe(true);
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "resumed" });
  });
});

describe("StateMachine list", () => {
  it("orders runs newest first and filters by definition and status", async () => {
    const stub = createHarnessStub();
    const first = await stub.startWaiter("first");
    await waitFor(stub, first.runId, ["waiting"]);
    const second = await stub.startWaiter("second");
    await waitFor(stub, second.runId, ["waiting"]);
    await stub.start("pipeline");

    const runs = await stub.listRuns({
      definition: "waiter",
      status: ["running", "waiting"],
      limit: 2
    });
    expect(runs.map((run) => run.runId)).toEqual([second.runId, first.runId]);
  });

  it("uses the definition index for the live-run query", async () => {
    expect(
      (await createHarnessStub().listRunsQueryPlan()).join("\n")
    ).toContain("cf_agents_state_machine_definition");
  });

  it("treats an empty status list as matching no runs", async () => {
    const stub = createHarnessStub();
    await stub.startWaiter("empty");

    expect(await stub.listRuns({ status: [] })).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_001])(
    "rejects invalid limit %s",
    async (limit) => {
      expect(await createHarnessStub().listRunsError({ limit })).toMatch(
        /integer between 1 and 1000/
      );
    }
  );
});
