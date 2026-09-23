import { describe, expect, it } from "vitest";
import { StateMachine, defineMachine } from "../../state-machine";
import { createHarnessStub, waitFor } from "./test-harness";

describe("StateMachine local children", () => {
  it.each([
    "__cf_state_machine_child_attached",
    "__cf_state_machine_child_background"
  ])("reserves the internal effect kind %s", (kind) => {
    const only = defineMachine<{ phase: "done" }, void>({
      version: 1,
      initial: () => ({ phase: "done" }),
      phases: {
        done: (_state, context) => context.complete()
      }
    });

    expect(
      () =>
        new StateMachine({
          definitions: { only },
          effects: {
            [kind]: { execute: async () => null }
          }
        })
    ).toThrow("StateMachine child effect kinds are reserved");
  });

  it("spawns and joins an attached child", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("work", "attached");

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "child:work" });
  });

  it("stores child execution as a reconcile effect", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("slow", "attached");
    const deadline = Date.now() + 5_000;
    let snapshot = await stub.runSnapshot(receipt.runId);

    while (snapshot?.effects?.[0]?.status !== "running") {
      if (Date.now() > deadline)
        throw new Error("child effect was not started");
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = await stub.runSnapshot(receipt.runId);
    }

    expect(snapshot.effects).toEqual([
      expect.objectContaining({
        kind: "__cf_state_machine_child_attached",
        recovery: "reconcile",
        status: "running"
      })
    ]);
  });

  it("does not lose a child that settles before the parent joins", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("early", "attached");

    const completed = await waitFor(stub, receipt.runId, ["completed"]);
    expect(completed.result).toBe("child:early");
    expect(completed.revision).toBeGreaterThanOrEqual(2);
  });

  it("reconciles after timeout when the completion event is missing", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("slow", "attached");
    const deadline = Date.now() + 5_000;
    let childRunId: string | undefined;

    while (!childRunId) {
      childRunId = (await stub.runSnapshot(receipt.runId))?.children?.[0]
        ?.runId;
      if (Date.now() > deadline) throw new Error("child was not accepted");
      if (!childRunId) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await stub.suppressChildCompletion(receipt.runId, childRunId);
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "child:slow" });
  });

  it("joins one caller-selected child from duplicate parent effects", async () => {
    const stub = createHarnessStub();
    const childRunId = `shared-${crypto.randomUUID()}`;
    const first = await stub.startParent("shared", "attached", childRunId);
    const second = await stub.startParent("shared", "attached", childRunId);

    await expect(
      waitFor(stub, first.runId, ["completed"])
    ).resolves.toMatchObject({ result: "child:shared" });
    await expect(
      waitFor(stub, second.runId, ["completed"])
    ).resolves.toMatchObject({ result: "child:shared" });
  });

  it("rejects a child run ID owned by another definition", async () => {
    const stub = createHarnessStub();
    const childRunId = `conflict-${crypto.randomUUID()}`;
    const first = await stub.startParent(
      "first",
      "attached",
      childRunId,
      "child"
    );
    await waitFor(stub, first.runId, ["completed"]);

    const conflicting = await stub.startParent(
      "second",
      "attached",
      childRunId,
      "otherChild"
    );
    await expect(
      waitFor(stub, conflicting.runId, ["failed"])
    ).resolves.toMatchObject({
      error: { message: expect.stringContaining("belongs to") }
    });
  });

  it("returns a failed child outcome to the parent", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("fail", "attached");

    await expect(
      waitFor(stub, receipt.runId, ["failed"])
    ).resolves.toMatchObject({ error: { message: "child failed" } });
  });

  it("returns direct child cancellation to the waiting parent", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startParent("wait", "attached");
    const deadline = Date.now() + 5_000;
    let childRunId: string | undefined;
    while (!childRunId) {
      childRunId = (await stub.runSnapshot(receipt.runId))?.children?.[0]
        ?.runId;
      if (Date.now() > deadline) throw new Error("child was not accepted");
      if (!childRunId) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await stub.cancelChild(childRunId);
    await expect(
      waitFor(stub, receipt.runId, ["failed"])
    ).resolves.toMatchObject({ error: { message: "test cancelled child" } });
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

  it("rejects a phase that exceeds the active child limit", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startFanout(101);

    await expect(
      waitFor(stub, receipt.runId, ["failed"])
    ).resolves.toMatchObject({
      error: { message: expect.stringContaining("too many active children") }
    });
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
    await expect(stub.deleteRun(receipt.runId)).resolves.toBe(true);
    await expect(
      waitFor(stub, childRunId, ["completed"])
    ).resolves.toMatchObject({
      result: "child:slow"
    });
  });
});
