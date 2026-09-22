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
    prompt: string,
    options?: { runId?: string; idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  inspect(runId: string): Promise<Snapshot | null>;
  abort(runId: string, reason?: string): Promise<boolean>;
  result(runId: string): Promise<string | null>;
  completeExecution(runId: string, result: string): Promise<void>;
  runtimeStatus(runId: string): Promise<string | null>;
};

function createStub(): TestHarnessStub {
  return env.WrappedHarnessObject.getByName(
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
      throw new Error(`Wrapped run ${runId} stayed ${snapshot?.status}`);
    }
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("wrapped durable harness runtime", () => {
  it("reconciles terminal output after eviction", async () => {
    const stub = createStub();
    const receipt = await stub.submit("research");
    await waitFor(stub, receipt.runId, "waiting");
    expect(await stub.runtimeStatus(receipt.runId)).toBe("running");

    await evictDurableObject(stub);
    await stub.completeExecution(receipt.runId, "finished research");

    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "finished research"
    });
    await expect(stub.result(receipt.runId)).resolves.toBe("finished research");
  });

  it("deduplicates dispatch by stable outer run ID", async () => {
    const stub = createStub();
    const first = await stub.submit("once", {
      idempotencyKey: "wrapped-once"
    });
    const duplicate = await stub.submit("once", {
      idempotencyKey: "wrapped-once"
    });
    expect(duplicate).toMatchObject({ runId: first.runId, accepted: false });
  });

  it("cancels the wrapped runtime with the outer run", async () => {
    const stub = createStub();
    const receipt = await stub.submit("cancel");
    await waitFor(stub, receipt.runId, "waiting");

    expect(await stub.abort(receipt.runId, "stop wrapped")).toBe(true);
    await expect(
      waitFor(stub, receipt.runId, "cancelled")
    ).resolves.toMatchObject({
      error: { message: "stop wrapped" }
    });
    expect(await stub.runtimeStatus(receipt.runId)).toBe("failed");
  });

  it("returns stable outcomes for a missing outer run", async () => {
    const stub = createStub();
    await expect(stub.inspect("missing")).resolves.toBeNull();
    await expect(stub.result("missing")).resolves.toBeNull();
    await expect(stub.abort("missing")).resolves.toBe(false);
  });
});
