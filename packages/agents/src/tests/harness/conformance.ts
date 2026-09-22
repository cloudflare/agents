import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

export type ConformanceSnapshot = {
  status: string;
  result?: string;
  error?: { message: string };
};

export type ConformanceHarness = {
  readonly stub: DurableObjectStub;
  submit(
    key: string,
    options?: { idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  settle(runId: string, key: string, value: string): Promise<void>;
  inspect(runId: string): Promise<ConformanceSnapshot | null>;
  result(runId: string): Promise<string | null>;
  abort(runId: string, reason: string): Promise<boolean>;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
};

export type ConformanceFactory = () => ConformanceHarness;

async function waitFor(
  harness: ConformanceHarness,
  runId: string,
  status: string,
  timeoutMs = 5_000
): Promise<ConformanceSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await harness.inspect(runId);
    if (snapshot?.status === status) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`Harness run ${runId} stayed ${snapshot?.status}`);
    }
    await runDurableObjectAlarm(harness.stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function runHarnessConformance(
  name: string,
  create: ConformanceFactory
): void {
  describe(`${name} harness conformance`, () => {
    it("accepts idempotently and retains its result", async () => {
      const harness = create();
      const first = await harness.submit("input", {
        idempotencyKey: `${name}:input`
      });
      const duplicate = await harness.submit("input", {
        idempotencyKey: `${name}:input`
      });
      expect(first.accepted).toBe(true);
      expect(duplicate).toMatchObject({ runId: first.runId, accepted: false });

      await harness.settle(first.runId, "input", "done");
      await expect(
        waitFor(harness, first.runId, "completed")
      ).resolves.toMatchObject({ result: "done" });
      await expect(harness.result(first.runId)).resolves.toBe("done");
    });

    it("restores a waiting run after eviction", async () => {
      const harness = create();
      const receipt = await harness.submit("eviction");
      await waitFor(harness, receipt.runId, "waiting");
      await evictDurableObject(harness.stub);
      await harness.settle(receipt.runId, "eviction", "restored");
      await expect(
        waitFor(harness, receipt.runId, "completed")
      ).resolves.toBeTruthy();
    });

    it("maps abort, pause, and resume", async () => {
      const harness = create();
      const paused = await harness.submit("pause");
      await waitFor(harness, paused.runId, "waiting");
      expect(await harness.pause(paused.runId)).toBe(true);
      await waitFor(harness, paused.runId, "paused");
      expect(await harness.resume(paused.runId)).toBe(true);

      const aborted = await harness.submit("abort");
      await waitFor(harness, aborted.runId, "waiting");
      expect(await harness.abort(aborted.runId, "stopped")).toBe(true);
      await expect(
        waitFor(harness, aborted.runId, "cancelled")
      ).resolves.toMatchObject({ error: { message: "stopped" } });
    });
  });
}
