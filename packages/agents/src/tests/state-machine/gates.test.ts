import { describe, expect, it } from "vitest";
import { createHarnessStub, waitFor } from "./test-harness";

async function startWaitingPermission(timeoutMs = 60_000) {
  const stub = createHarnessStub();
  const receipt = await stub.startPermission(timeoutMs);
  const waiting = await waitFor(stub, receipt.runId, ["waiting"]);
  const gate = waiting.gates?.[0];
  if (!gate) throw new Error("permission gate was not published");
  return { stub, receipt, gate };
}

describe("StateMachine gates", () => {
  it("publishes public metadata and accepts an approval", async () => {
    const { stub, receipt, gate } = await startWaitingPermission();
    expect(gate).toMatchObject({ kind: "permission", state: "open" });

    await expect(
      stub.answerPermission(gate.gateId, true, "approve-1")
    ).resolves.toEqual({ status: "accepted" });
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "approved" });
  });

  it("returns a denied decision", async () => {
    const { stub, receipt, gate } = await startWaitingPermission();
    await stub.answerPermission(gate.gateId, false, "deny-1");
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "denied" });
  });

  it("rejects an answer with the wrong gate kind", async () => {
    const { stub, gate } = await startWaitingPermission();
    await expect(
      stub.answerWrongPermissionKind(gate.gateId, "wrong-kind")
    ).resolves.toEqual({ status: "wrong-kind" });
  });

  it("withdraws a gate and wakes its machine", async () => {
    const { stub, receipt, gate } = await startWaitingPermission();
    await expect(stub.withdrawPermission(gate.gateId)).resolves.toBe(true);
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "withdrawn" });
  });

  it("deduplicates an answer by event ID", async () => {
    const { stub, gate } = await startWaitingPermission();
    expect(
      await stub.answerPermission(gate.gateId, true, "answer-same")
    ).toEqual({
      status: "accepted"
    });
    expect(
      await stub.answerPermission(gate.gateId, true, "answer-same")
    ).toEqual({
      status: "duplicate"
    });
  });

  it("expires without accepting a late approval", async () => {
    const { stub, receipt, gate } = await startWaitingPermission(20);
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "expired" });
    await expect(
      stub.answerPermission(gate.gateId, true, "late-answer")
    ).resolves.toMatchObject({ status: "expired" });
  });
});
