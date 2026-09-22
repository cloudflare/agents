import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StateMachineHarnessObject } from "../capabilities/state-machine";

async function waitForTerminal(
  stub: DurableObjectStub<StateMachineHarnessObject>,
  runId: string,
  timeoutMs = 5_000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await stub.snapshot(runId);
    if (snapshot?.status === "completed" || snapshot?.status === "failed") {
      return snapshot;
    }
    if (Date.now() > deadline) throw new Error("machine did not settle");
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("StateMachine capability", () => {
  it("runs a typed three-phase machine to completion", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const receipt = await stub.start("alpha");
    await expect(waitForTerminal(stub, receipt.runId)).resolves.toMatchObject({
      status: "completed",
      result: "done:alpha",
      revision: 3
    });
  });

  it("deduplicates acceptance by caller-selected run ID", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const runId = `machine_${crypto.randomUUID()}`;
    expect((await stub.start("alpha", runId)).accepted).toBe(true);
    expect((await stub.start("alpha", runId)).accepted).toBe(false);
    await expect(waitForTerminal(stub, runId)).resolves.toMatchObject({
      status: "completed",
      result: "done:alpha"
    });
  });

  it("survives eviction after durable acceptance", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const receipt = await stub.start("evicted");
    await evictDurableObject(stub);
    await expect(waitForTerminal(stub, receipt.runId)).resolves.toMatchObject({
      status: "completed",
      result: "done:evicted",
      revision: 3
    });
  });

  it("ignores a stale job dispatch after the run advances", async () => {
    const stub = env.StateMachineHarnessObject.getByName(crypto.randomUUID());
    const receipt = await stub.start("stale");
    const settled = await waitForTerminal(stub, receipt.runId);

    await runInDurableObject(
      stub,
      async (instance: StateMachineHarnessObject) => {
        await instance.stateMachine.onJob({
          attempt: 1,
          job: {
            id: `state-machine:${receipt.runId}`,
            capability: "state-machine",
            fn: "drive",
            time: Date.now(),
            payload: { runId: receipt.runId, revision: 0 },
            retry: undefined,
            singleflight: true,
            exclusive: false,
            recoveryLoop: false,
            createdAt: Date.now()
          }
        });
      }
    );

    expect(await stub.snapshot(receipt.runId)).toEqual(settled);
  });
});
