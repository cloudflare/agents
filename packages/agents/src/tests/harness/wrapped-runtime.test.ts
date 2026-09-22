import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Snapshot = {
  status: string;
  result?: string;
  error?: { message: string };
};

type WrappedStub = DurableObjectStub & {
  wrappedSubmit(
    prompt: string,
    options?: { runId?: string; idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  wrappedInspect(runId: string): Promise<Snapshot | null>;
  wrappedAbort(runId: string, reason?: string): Promise<boolean>;
  wrappedResult(runId: string): Promise<string | null>;
  completeWrapped(runId: string, result: string): Promise<void>;
  wrappedRuntimeStatus(runId: string): Promise<string | null>;
};

function createStub(): WrappedStub {
  return env.StateMachineHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as WrappedStub;
}

async function waitFor(
  stub: WrappedStub,
  runId: string,
  status: string,
  timeoutMs = 5_000
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await stub.wrappedInspect(runId);
    if (snapshot?.status === status) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`Wrapped run ${runId} stayed ${snapshot?.status}`);
    }
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("wrapped durable harness runtime", () => {
  it("reconciles terminal output after eviction", async () => {
    const stub = createStub();
    const receipt = await stub.wrappedSubmit("research");
    await waitFor(stub, receipt.runId, "waiting");
    expect(await stub.wrappedRuntimeStatus(receipt.runId)).toBe("running");

    await evictDurableObject(stub);
    await stub.completeWrapped(receipt.runId, "finished research");

    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "finished research"
    });
    await expect(stub.wrappedResult(receipt.runId)).resolves.toBe(
      "finished research"
    );
  });

  it("deduplicates dispatch by stable outer run ID", async () => {
    const stub = createStub();
    const first = await stub.wrappedSubmit("once", {
      idempotencyKey: "wrapped-once"
    });
    const duplicate = await stub.wrappedSubmit("once", {
      idempotencyKey: "wrapped-once"
    });
    expect(duplicate).toMatchObject({ runId: first.runId, accepted: false });
  });

  it("cancels the wrapped runtime with the outer run", async () => {
    const stub = createStub();
    const receipt = await stub.wrappedSubmit("cancel");
    await waitFor(stub, receipt.runId, "waiting");

    expect(await stub.wrappedAbort(receipt.runId, "stop wrapped")).toBe(true);
    await expect(
      waitFor(stub, receipt.runId, "cancelled")
    ).resolves.toMatchObject({
      error: { message: "stop wrapped" }
    });
    expect(await stub.wrappedRuntimeStatus(receipt.runId)).toBe("failed");
  });
});
