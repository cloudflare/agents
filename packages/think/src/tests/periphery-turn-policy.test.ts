import type { ModelMessage, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  ThinkContextOverflow,
  TransientChatStreamError,
  type ThinkContextOverflowOptions
} from "../context-overflow";
import {
  wrapToolsWithDecision,
  type ToolDecisionHooks
} from "../tool-decision";
import type { ContextOverflowConfig, PrepareStepContext } from "../turn-types";

function overflow(
  config: ContextOverflowConfig | undefined,
  overrides: Partial<ThinkContextOverflowOptions> = {}
) {
  const emitted: Array<[string, Record<string, unknown>]> = [];
  const guard = new ThinkContextOverflow({
    config: () => config,
    classifierOverridden: () => true,
    classify: () => "context_overflow",
    compact: async () => ({ id: "summary" }),
    emit: (type, payload) => emitted.push([type, payload]),
    onChatError: (error) => error,
    rebuildMessages: async () => [{ role: "user", content: "summary" }],
    ...overrides
  });
  return { guard, emitted };
}

function stepEvent(inputTokens: number, messages: ModelMessage[]) {
  return {
    steps: [{ usage: { inputTokens } }],
    messages,
    stepNumber: 1
  } as unknown as PrepareStepContext;
}

describe("ThinkContextOverflow", () => {
  it("is off without config", () => {
    const { guard } = overflow(undefined);
    expect(guard.reactiveEnabled).toBe(false);
    expect(guard.maxRetries).toBe(1);
    expect(guard.isRecoverable("context_overflow")).toBe(false);
  });

  it("warns once when reactive is on but nothing classifies", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { guard } = overflow(
      { reactive: true },
      { classifierOverridden: () => false }
    );
    expect(guard.isRecoverable("context_overflow")).toBe(false);
    expect(guard.isRecoverable("context_overflow")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("treats a thrown classifier as unclassified", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { guard } = overflow(
      { reactive: true },
      {
        classify: () => {
          throw new Error("bad classifier");
        }
      }
    );
    expect(guard.classifyStreamError(new Error("x"), "r")).toBeUndefined();
    warn.mockRestore();
  });

  it("finds transient errors", () => {
    const { guard } = overflow(undefined, { classify: () => "rate_limit" });
    expect(
      guard.transientClassification(
        new TransientChatStreamError("x", "transient", null),
        "r"
      )
    ).toBe("transient");
    expect(guard.transientClassification(new Error("429"), "r")).toBe(
      "rate_limit"
    );
  });

  it("reports whether compaction shortened history", async () => {
    const { guard, emitted } = overflow(
      { reactive: true },
      { compact: async () => null }
    );
    expect(await guard.compact("reactive", { requestId: "r" })).toBe(false);
    expect(emitted).toEqual([
      [
        "chat:context:compacted",
        { reason: "reactive", shortened: false, requestId: "r" }
      ]
    ]);
  });

  it("finalizes an overflow through onChatError", () => {
    const { guard, emitted } = overflow(
      { reactive: true },
      { onChatError: (error) => new Error(`wrapped: ${String(error)}`) }
    );
    expect(guard.finalize("r", undefined)).toBe(
      "wrapped: Context window exceeded."
    );
    expect(emitted[0][0]).toBe("chat:request:failed");
  });

  it("compacts before a step over budget and keeps the in-flight tail", async () => {
    const { guard } = overflow({ proactive: { maxInputTokens: 100 } });
    const head: ModelMessage = { role: "user", content: "old" };
    const step: ModelMessage = { role: "assistant", content: "in flight" };
    guard.beginRun(1);
    expect(await guard.compactBeforeStep(stepEvent(50, [head, step]))).toBe(
      undefined
    );
    expect(await guard.compactBeforeStep(stepEvent(95, [head, step]))).toEqual([
      { role: "user", content: "summary" },
      step
    ]);
    // The default cap is one compaction per run.
    expect(
      await guard.compactBeforeStep(stepEvent(95, [head, step]))
    ).toBeUndefined();
    guard.beginRun(1);
    expect(await guard.compactBeforeStep(stepEvent(95, [head, step]))).toEqual([
      { role: "user", content: "summary" },
      step
    ]);
  });
});

describe("wrapToolsWithDecision", () => {
  const options = { toolCallId: "call-1", messages: [] };

  function hooks(overrides: Partial<ToolDecisionHooks> = {}) {
    return {
      beforeToolCall: () => undefined,
      observeStart: vi.fn(async () => {}),
      requestId: () => "req",
      rejectChangedApprovedInput: () => undefined,
      ...overrides
    } satisfies ToolDecisionHooks;
  }

  function run(tools: ToolSet, name: string, input: unknown) {
    const execute = tools[name].execute as (
      input: unknown,
      options: unknown
    ) => unknown;
    return execute(input, options);
  }

  it("leaves a tool without execute alone", () => {
    const tool = { inputSchema: {} } as unknown as ToolSet[string];
    expect(wrapToolsWithDecision({ t: tool }, hooks()).t).toBe(tool);
  });

  it("runs, blocks or substitutes as the decision says", async () => {
    const execute = vi.fn(async (input: unknown) => ({ ran: input }));
    const tools = { t: { execute } } as unknown as ToolSet;
    const observe = hooks();
    expect(
      await run(wrapToolsWithDecision(tools, observe), "t", { a: 1 })
    ).toEqual({ ran: { a: 1 } });
    expect(observe.observeStart).toHaveBeenCalledOnce();

    const allow = hooks({
      beforeToolCall: () => ({ action: "allow", input: { a: 2 } })
    });
    expect(await run(wrapToolsWithDecision(tools, allow), "t", {})).toEqual({
      ran: { a: 2 }
    });

    const block = hooks({ beforeToolCall: () => ({ action: "block" }) });
    expect(await run(wrapToolsWithDecision(tools, block), "t", {})).toBe(
      'Tool "t" was blocked by beforeToolCall.'
    );

    const substitute = hooks({
      beforeToolCall: () => ({ action: "substitute", output: 42 })
    });
    expect(await run(wrapToolsWithDecision(tools, substitute), "t", {})).toBe(
      42
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("refuses changed input for an approved action", async () => {
    const execute = vi.fn(async () => "ran");
    const tools = {
      act: {
        execute,
        metadata: {
          cfThinkAction: true,
          cfThinkActionApprovalConfigured: true
        }
      }
    } as unknown as ToolSet;
    const wrapped = wrapToolsWithDecision(
      tools,
      hooks({ rejectChangedApprovedInput: () => "changed" })
    );
    expect(await run(wrapped, "act", {})).toBe("changed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("streams an async generator tool through", async () => {
    async function* execute() {
      yield 1;
      yield 2;
    }
    const tools = { s: { execute } } as unknown as ToolSet;
    const iterable = run(
      wrapToolsWithDecision(tools, hooks()),
      "s",
      {}
    ) as AsyncIterable<number>;
    const parts: number[] = [];
    for await (const part of iterable) parts.push(part);
    expect(parts).toEqual([1, 2]);
  });

  it("collapses a promised iterable to its last value", async () => {
    const tools = {
      s: {
        execute: async () =>
          (async function* () {
            yield "a";
            yield "b";
          })()
      }
    } as unknown as ToolSet;
    expect(await run(wrapToolsWithDecision(tools, hooks()), "s", {})).toBe("b");
  });
});
