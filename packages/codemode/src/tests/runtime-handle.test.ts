import { asSchema, streamText } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor";
import { createCodemodeRuntime } from "../runtime-handle";

function createMockCtx(runtimeStub: unknown): DurableObjectState {
  return {
    facets: {
      get: vi.fn(() => runtimeStub)
    },
    exports: {
      CodemodeRuntime: class MockCodemodeRuntime {}
    }
  } as unknown as DurableObjectState;
}

function createMockCtxWithoutRuntimeExport(): DurableObjectState {
  return {
    facets: {
      get: vi.fn()
    },
    exports: {}
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

  it("throws a clear error when CodemodeRuntime is not exported", () => {
    const runtime = createCodemodeRuntime({
      ctx: createMockCtxWithoutRuntimeExport(),
      executor: createMockExecutor(),
      connectors: []
    });

    expect(() => runtime.tool()).toThrow(
      "CodemodeRuntime is not exported from this Worker entry"
    );
  });

  it("exposes the model-facing tool from the runtime handle", async () => {
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

    const inputSchema = asSchema(codemode.inputSchema);
    expect(inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false
    });
    await expect(inputSchema.validate?.({ code: "return 1" })).resolves.toEqual(
      { success: true, value: { code: "return 1" } }
    );
    await expect(inputSchema.validate?.({ code: 1 })).resolves.toMatchObject({
      success: false
    });
  });

  it("executes as a plain tool through AI SDK streamText", async () => {
    const runtimeStub = {
      begin: vi.fn(async () => "exec_1"),
      getExecution: vi.fn(async () => null),
      complete: vi.fn(async () => undefined)
    };
    const executor = createMockExecutor("executed");
    const runtime = createCodemodeRuntime({
      ctx: createMockCtx(runtimeStub),
      executor,
      connectors: []
    });
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "codemode",
              input: JSON.stringify({ code: "return 1" })
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 }
              }
            }
          ]
        })
      }
    });

    const result = streamText({
      model,
      prompt: "Execute the code",
      tools: { codemode: runtime.tool() }
    });

    await expect(result.toolResults).resolves.toEqual([
      expect.objectContaining({
        toolCallId: "call_1",
        toolName: "codemode",
        input: { code: "return 1" },
        output: {
          status: "completed",
          executionId: "exec_1",
          result: "executed",
          logs: undefined
        }
      })
    ]);
    expect(executor.execute).toHaveBeenCalled();
    expect(runtimeStub.complete).toHaveBeenCalledWith(
      "exec_1",
      "executed",
      undefined
    );
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
