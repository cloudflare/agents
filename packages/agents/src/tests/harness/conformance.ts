import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

export type ConformanceSnapshot = {
  status: string;
  result?: string;
  error?: { message: string };
  gates?: Array<{ gateId: string }>;
};

export type ConformanceHarness = {
  readonly stub: DurableObjectStub;
  submit(
    key: string,
    options?: { runId?: string; idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  settle(runId: string, key: string, value: string): Promise<string>;
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
  while (true) {
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
      const runId = `${name}-input`;
      const first = await harness.submit("input", {
        runId,
        idempotencyKey: `${name}:input`
      });
      const duplicate = await harness.submit("input", {
        runId,
        idempotencyKey: `${name}:input`
      });
      expect(first.accepted).toBe(true);
      expect(duplicate).toMatchObject({ runId: first.runId, accepted: false });

      await expect(harness.result(first.runId)).resolves.toBeNull();
      const expected = await harness.settle(first.runId, "input", "done");
      await expect(
        waitFor(harness, first.runId, "completed")
      ).resolves.toMatchObject({ result: expected });
      await expect(harness.result(first.runId)).resolves.toBe(expected);
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
      expect(await harness.pause(paused.runId)).toBe(false);
      expect(await harness.resume(paused.runId)).toBe(true);
      expect(await harness.resume(paused.runId)).toBe(false);

      const aborted = await harness.submit("abort");
      await waitFor(harness, aborted.runId, "waiting");
      expect(await harness.abort(aborted.runId, "stopped")).toBe(true);
      await expect(
        waitFor(harness, aborted.runId, "cancelled")
      ).resolves.toMatchObject({ error: { message: "stopped" } });
      expect(await harness.abort(aborted.runId, "again")).toBe(false);
    });

    it("returns stable outcomes for a missing run", async () => {
      const harness = create();
      await expect(harness.inspect("missing")).resolves.toBeNull();
      await expect(harness.result("missing")).resolves.toBeNull();
      await expect(harness.abort("missing", "none")).resolves.toBe(false);
      await expect(harness.pause("missing")).resolves.toBe(false);
      await expect(harness.resume("missing")).resolves.toBe(false);
    });
  });
}
