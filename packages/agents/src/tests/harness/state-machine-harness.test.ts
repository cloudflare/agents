import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Snapshot = {
  status: string;
  result?: string;
  error?: { message: string };
};

type HarnessStub = DurableObjectStub & {
  harnessSubmit(
    key: string,
    options?: { runId?: string; idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  harnessSend(
    runId: string,
    key: string,
    value: string,
    eventId: string
  ): Promise<{ status: string }>;
  harnessInspect(runId: string): Promise<Snapshot | null>;
  harnessAbort(runId: string, reason?: string): Promise<boolean>;
  harnessPause(runId: string): Promise<boolean>;
  harnessResume(runId: string): Promise<boolean>;
  harnessResult(runId: string): Promise<string | null>;
};

function createStub(): HarnessStub {
  return env.StateMachineHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as HarnessStub;
}

async function waitFor(
  stub: HarnessStub,
  runId: string,
  status: string,
  timeoutMs = 5_000
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await stub.harnessInspect(runId);
    if (snapshot?.status === status) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`Harness run ${runId} stayed ${snapshot?.status}`);
    }
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("StateMachineHarness", () => {
  it("submits idempotently and settles through a typed event", async () => {
    const stub = createStub();
    const first = await stub.harnessSubmit("input", {
      idempotencyKey: "submission-1"
    });
    const duplicate = await stub.harnessSubmit("input", {
      idempotencyKey: "submission-1"
    });
    expect(first.accepted).toBe(true);
    expect(duplicate).toMatchObject({ runId: first.runId, accepted: false });

    await stub.harnessSend(first.runId, "input", "finished", "input-event-1");
    await expect(
      waitFor(stub, first.runId, "completed")
    ).resolves.toMatchObject({
      result: "finished"
    });
    await expect(stub.harnessResult(first.runId)).resolves.toBe("finished");
  });

  it("preserves a waiting run across eviction", async () => {
    const stub = createStub();
    const receipt = await stub.harnessSubmit("eviction");
    await waitFor(stub, receipt.runId, "waiting");
    await evictDurableObject(stub);

    await stub.harnessSend(
      receipt.runId,
      "eviction",
      "restored",
      "eviction-event"
    );
    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "restored"
    });
  });

  it("maps durable abort, pause, and resume", async () => {
    const stub = createStub();
    const paused = await stub.harnessSubmit("pause");
    await waitFor(stub, paused.runId, "waiting");
    expect(await stub.harnessPause(paused.runId)).toBe(true);
    await expect(waitFor(stub, paused.runId, "paused")).resolves.toBeTruthy();
    expect(await stub.harnessResume(paused.runId)).toBe(true);

    const aborted = await stub.harnessSubmit("abort");
    await waitFor(stub, aborted.runId, "waiting");
    expect(await stub.harnessAbort(aborted.runId, "stop")).toBe(true);
    await expect(
      waitFor(stub, aborted.runId, "cancelled")
    ).resolves.toMatchObject({
      error: { message: "stop" }
    });
  });
});
