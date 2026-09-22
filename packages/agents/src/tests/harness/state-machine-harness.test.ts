import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Snapshot = {
  status: string;
  result?: string;
  error?: { message: string };
};

type TestHarnessStub = DurableObjectStub & {
  submit(
    key: string,
    options?: { runId?: string; idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  send(
    runId: string,
    key: string,
    value: string,
    eventId: string
  ): Promise<{ status: string }>;
  inspect(runId: string): Promise<Snapshot | null>;
  abort(runId: string, reason?: string): Promise<boolean>;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  result(runId: string): Promise<string | null>;
};

function createStub(): TestHarnessStub {
  return env.StateMachineAdapterHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as TestHarnessStub;
}

async function waitFor(
  stub: TestHarnessStub,
  runId: string,
  status: string,
  timeoutMs = 5_000
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await stub.inspect(runId);
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
    const first = await stub.submit("input", {
      idempotencyKey: "submission-1"
    });
    const duplicate = await stub.submit("input", {
      idempotencyKey: "submission-1"
    });
    expect(first.accepted).toBe(true);
    expect(duplicate).toMatchObject({ runId: first.runId, accepted: false });

    await expect(stub.result(first.runId)).resolves.toBeNull();
    await stub.send(first.runId, "input", "finished", "input-event-1");
    await expect(
      waitFor(stub, first.runId, "completed")
    ).resolves.toMatchObject({
      result: "finished"
    });
    await expect(stub.result(first.runId)).resolves.toBe("finished");
    await expect(
      stub.send(first.runId, "input", "late", "input-event-late")
    ).resolves.toEqual({ status: "terminal" });
  });

  it("preserves a waiting run across eviction", async () => {
    const stub = createStub();
    const receipt = await stub.submit("eviction");
    await waitFor(stub, receipt.runId, "waiting");
    await evictDurableObject(stub);

    await stub.send(receipt.runId, "eviction", "restored", "eviction-event");
    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "restored"
    });
  });

  it("maps durable abort, pause, and resume", async () => {
    const stub = createStub();
    const paused = await stub.submit("pause");
    await waitFor(stub, paused.runId, "waiting");
    expect(await stub.pause(paused.runId)).toBe(true);
    await expect(waitFor(stub, paused.runId, "paused")).resolves.toBeTruthy();
    expect(await stub.pause(paused.runId)).toBe(false);
    expect(await stub.resume(paused.runId)).toBe(true);
    expect(await stub.resume(paused.runId)).toBe(false);

    const aborted = await stub.submit("abort");
    await waitFor(stub, aborted.runId, "waiting");
    expect(await stub.abort(aborted.runId, "stop")).toBe(true);
    await expect(
      waitFor(stub, aborted.runId, "cancelled")
    ).resolves.toMatchObject({
      error: { message: "stop" }
    });
    expect(await stub.abort(aborted.runId, "again")).toBe(false);
  });

  it("returns stable outcomes for a missing run", async () => {
    const stub = createStub();
    await expect(stub.inspect("missing")).resolves.toBeNull();
    await expect(stub.result("missing")).resolves.toBeNull();
    await expect(stub.abort("missing")).resolves.toBe(false);
    await expect(stub.pause("missing")).resolves.toBe(false);
    await expect(stub.resume("missing")).resolves.toBe(false);
    await expect(
      stub.send("missing", "input", "ignored", "missing-event")
    ).resolves.toEqual({ status: "not-found" });
  });
});
