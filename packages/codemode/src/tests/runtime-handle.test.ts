import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor";
import { createCodemodeRuntime } from "../runtime-handle";

function createMockCtx(runtimeStub: unknown): DurableObjectState {
  return {
    facets: {
      get: vi.fn(() => runtimeStub)
    }
  } as unknown as DurableObjectState;
}

function createMockExecutor(result: unknown = "ok"): Executor {
  return {
    execute: vi.fn(async () => ({ result }))
  };
}

describe("createCodemodeRuntime", () => {
  it("exposes the model-facing tool from the runtime handle", () => {
    const runtimeStub = {};
    const ctx = createMockCtx(runtimeStub);
    const executor = createMockExecutor();

    const runtime = createCodemodeRuntime({
      ctx,
      executor,
      connectors: []
    });

    const codemode = runtime.tool();

    expect(codemode).toBeDefined();
    expect(codemode.execute).toBeDefined();
  });

  it("approves a paused execution using the runtime's executor and connectors", async () => {
    const execution = {
      id: "exec_1",
      code: "async () => 'approved'",
      status: "running" as const,
      log: []
    };
    const runtimeStub = {
      resume: vi.fn(async () => execution),
      configure: vi.fn(async () => undefined),
      getExecution: vi.fn(async () => execution),
      complete: vi.fn(async () => undefined)
    };
    const ctx = createMockCtx(runtimeStub);
    const executor = createMockExecutor("approved");

    const runtime = createCodemodeRuntime({
      ctx,
      executor,
      connectors: []
    });

    await expect(runtime.approve({ executionId: "exec_1" })).resolves.toEqual({
      status: "completed",
      result: "approved",
      logs: undefined
    });

    expect(runtimeStub.resume).toHaveBeenCalledWith("exec_1");
    expect(executor.execute).toHaveBeenCalled();
    expect(runtimeStub.complete).toHaveBeenCalledWith("approved", undefined);
  });

  it("lists pending actions awaiting approval", async () => {
    const pending = [
      {
        executionId: "exec_1",
        seq: 1,
        connector: "github",
        method: "create_issue",
        args: { title: "hi" }
      }
    ];
    const runtimeStub = {
      listPending: vi.fn(async () => pending)
    };
    const ctx = createMockCtx(runtimeStub);

    const runtime = createCodemodeRuntime({
      ctx,
      executor: createMockExecutor(),
      connectors: []
    });

    await expect(runtime.pending()).resolves.toEqual(pending);
  });
});
