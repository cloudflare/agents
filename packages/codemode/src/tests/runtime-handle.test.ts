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
  it("rejects duplicate and reserved connector names up front", () => {
    const named = (name: string) =>
      ({
        name: () => name
      }) as unknown as import("../connectors").CodemodeConnector;
    const base = {
      ctx: createMockCtx({}),
      executor: createMockExecutor()
    };

    expect(() =>
      createCodemodeRuntime({
        ...base,
        connectors: [named("state"), named("state")]
      })
    ).toThrow('Duplicate connector name "state"');

    expect(() =>
      createCodemodeRuntime({ ...base, connectors: [named("codemode")] })
    ).toThrow("reserved");

    expect(() =>
      createCodemodeRuntime({
        ...base,
        connectors: [named("state"), named("cdp")]
      })
    ).not.toThrow();
  });

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
      log: [],
      createdAt: 1,
      updatedAt: 1
    };
    const runtimeStub = {
      resume: vi.fn(async () => execution),
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
      executionId: "exec_1",
      result: "approved",
      logs: undefined
    });

    expect(runtimeStub.resume).toHaveBeenCalledWith("exec_1");
    expect(executor.execute).toHaveBeenCalled();
    expect(runtimeStub.complete).toHaveBeenCalledWith(
      "exec_1",
      "approved",
      undefined
    );
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

  it("exposes the audit trail and snippet curation to the developer", async () => {
    const executions = [
      { id: "exec_2", code: "async () => 2", status: "completed", log: [] }
    ];
    const snippet = { name: "s", description: "", code: "", savedAt: 1 };
    const runtimeStub = {
      listExecutions: vi.fn(async () => executions),
      saveSnippet: vi.fn(async () => snippet),
      listSnippets: vi.fn(async () => [snippet]),
      deleteSnippet: vi.fn(async () => true)
    };
    const runtime = createCodemodeRuntime({
      ctx: createMockCtx(runtimeStub),
      executor: createMockExecutor(),
      connectors: []
    });

    await expect(runtime.executions()).resolves.toEqual(executions);
    await expect(
      runtime.saveSnippet("s", { executionId: "exec_2" })
    ).resolves.toEqual(snippet);
    expect(runtimeStub.saveSnippet).toHaveBeenCalledWith("s", {
      executionId: "exec_2"
    });
    await expect(runtime.snippets()).resolves.toEqual([snippet]);
    await expect(runtime.deleteSnippet("s")).resolves.toBe(true);
  });
});
