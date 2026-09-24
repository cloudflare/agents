import { ok, type OperationResultRecord } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { PiRuntimeAdapter, type PiDriverLane } from "../../pi/runtime-adapter";

function result(operationId: string): OperationResultRecord {
  return {
    operationId,
    kind: "run",
    status: "completed",
    fromTipId: null,
    tipId: "tip",
    startedAt: 1,
    endedAt: 2
  };
}

describe("PiRuntimeAdapter", () => {
  it("reads terminal and active operation state from Pi", async () => {
    let current: string | null = "op-active";
    const records = new Map<string, OperationResultRecord>([
      ["op-done", result("op-done")]
    ]);
    const lane = {
      getResult: async (operationId: string) => records.get(operationId),
      inspectExecution: async () => ({
        lane: "main",
        tipId: null,
        configuredModel: { provider: "test", modelId: "model" },
        current:
          current === null
            ? null
            : {
                id: current,
                kind: "run" as const,
                status: "open" as const,
                startedAt: 1,
                capturedModel: { provider: "test", modelId: "model" }
              },
        lastOperationId: null
      }),
      accept: async () =>
        ok({ operationId: "op-new", kind: "run" as const, startedAt: 1 }),
      drive: async () =>
        ok({ kind: "settled" as const, outcome: result("op-active") }),
      requestAbort: async (operationId: string) =>
        ok({ operationId, newlyRequested: true, steer: [], followUp: [] })
    } satisfies PiDriverLane;
    const adapter = new PiRuntimeAdapter({ lane: async () => lane });

    expect(await adapter.inspect("main", "op-done")).toEqual({
      status: "completed",
      result: expect.objectContaining({
        operationId: "op-done",
        status: "completed"
      })
    });
    expect(await adapter.inspect("main", "op-active")).toEqual({
      status: "active"
    });
    expect(await adapter.inspect("main", "op-other")).toMatchObject({
      status: "waiting"
    });
    current = null;
    expect(await adapter.inspect("main", "op-new")).toEqual({
      status: "not-admitted"
    });
  });

  it("maps Pi retry, deferred, and settlement outcomes", async () => {
    let outcome:
      | {
          kind: "waiting";
          operationId: string;
          reason: "retry";
          notBefore: number;
        }
      | {
          kind: "waiting";
          operationId: string;
          reason: "deferred";
          deferred: {
            provider: string;
            modelId: string;
            api: string;
            id: string;
            pollAfterMs?: number;
          };
        }
      | { kind: "settled"; outcome: OperationResultRecord } = {
      kind: "waiting",
      operationId: "op-1",
      reason: "retry",
      notBefore: 123
    };
    const lane = {
      getResult: async () => undefined,
      inspectExecution: async () => ({
        lane: "main",
        tipId: null,
        configuredModel: { provider: "test", modelId: "model" },
        current: {
          id: "op-1",
          kind: "run" as const,
          status: "open" as const,
          startedAt: 1,
          capturedModel: { provider: "test", modelId: "model" }
        },
        lastOperationId: null
      }),
      accept: async () =>
        ok({ operationId: "op-1", kind: "run" as const, startedAt: 1 }),
      drive: async () => ok(outcome),
      requestAbort: async (operationId: string) =>
        ok({ operationId, newlyRequested: true, steer: [], followUp: [] })
    } satisfies PiDriverLane;
    const adapter = new PiRuntimeAdapter({
      lane: async () => lane,
      deferredPollMs: 500
    });

    expect(
      await adapter.drive("main", "op-1", new AbortController().signal)
    ).toEqual({
      status: "waiting",
      notBefore: 123
    });

    outcome = {
      kind: "waiting",
      operationId: "op-1",
      reason: "deferred",
      deferred: {
        provider: "test",
        modelId: "model",
        api: "test",
        id: "deferred",
        pollAfterMs: 250
      }
    };
    const before = Date.now();
    const deferred = await adapter.drive(
      "main",
      "op-1",
      new AbortController().signal
    );
    expect(deferred).toMatchObject({ status: "waiting" });
    if (deferred.status === "waiting") {
      expect(deferred.notBefore).toBeGreaterThanOrEqual(before + 250);
    }

    outcome = { kind: "settled", outcome: result("op-1") };
    expect(
      await adapter.drive("main", "op-1", new AbortController().signal)
    ).toEqual({
      status: "completed",
      result: expect.objectContaining({ operationId: "op-1" })
    });
  });
});
