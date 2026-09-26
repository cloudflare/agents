import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StateMachineHarnessObject } from "../capabilities/state-machine";

async function waitForSettlement(
  stub: DurableObjectStub<StateMachineHarnessObject>,
  runId: string
) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const snapshot = await stub.runSnapshot(runId);
    if (snapshot?.status !== "running") return snapshot;
    if (Date.now() > deadline) throw new Error("machine did not settle");
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("StateMachine durable commits", () => {
  it("commits a participant write with the checkpoint transition", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const receipt = await stub.startParticipant("committed");
    await expect(waitForSettlement(stub, receipt.runId)).resolves.toMatchObject(
      {
        status: "completed",
        result: "committed"
      }
    );
    expect(await stub.committedValues()).toEqual(["committed"]);
  });

  it("rolls back participant writes when the participant fails", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const receipt = await stub.startParticipant("rolled-back", true);
    await expect(waitForSettlement(stub, receipt.runId)).resolves.toMatchObject(
      {
        status: "failed",
        error: { message: "participant failed" }
      }
    );
    expect(await stub.committedValues()).toEqual([]);
  });

  it("settles a stream with the terminal machine commit", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const streamId = `stream_${crypto.randomUUID()}`;
    const receipt = await stub.startStreamSettlement(streamId);

    await expect(waitForSettlement(stub, receipt.runId)).resolves.toMatchObject(
      {
        status: "completed",
        result: streamId
      }
    );
    await expect(stub.streamState(streamId)).resolves.toBe("completed");
  });

  it("keeps the stream live when a later participant rolls back", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const streamId = `stream_${crypto.randomUUID()}`;
    const receipt = await stub.startStreamSettlement(streamId, true);

    await expect(waitForSettlement(stub, receipt.runId)).resolves.toMatchObject(
      {
        status: "failed",
        error: { message: "later participant failed" }
      }
    );
    await expect(stub.streamState(streamId)).resolves.toBe("streaming");
  });
});
