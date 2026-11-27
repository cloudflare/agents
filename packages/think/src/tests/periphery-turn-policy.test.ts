import type { ModelMessage, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { TransientChatStreamError } from "agents/chat";
import {
  ThinkContextOverflow,
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
  it("keeps the compacted head on a later step whether or not the AI SDK carried it", async () => {
    const original: ModelMessage[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "now" }
    ];
    const step1: ModelMessage = { role: "assistant", content: "step 1" };
    const step2: ModelMessage = { role: "assistant", content: "step 2" };
    const fresh = () => {
      const { guard } = overflow({
        proactive: { maxInputTokens: 10, maxCompactions: 1 }
      });
      guard.beginRun(original);
      return guard;
    };
    // Before step 2: compacts, and sends the head with step 1.
    const guard6 = fresh();
    const compacted = await guard6.compactBeforeStep(
      stepEvent(10, [...original, step1])
    );
    expect(compacted).toEqual([{ role: "user", content: "summary" }, step1]);
    // AI SDK 6: step 3 gets the run's original messages again.
    expect(
      await guard6.compactBeforeStep(stepEvent(10, [...original, step1, step2]))
    ).toEqual([{ role: "user", content: "summary" }, step1, step2]);
    // AI SDK 7: step 3 gets the override, carried; nothing to change.
    const guard7 = fresh();
    const head = await guard7.compactBeforeStep(
      stepEvent(10, [...original, step1])
    );
    expect(
      await guard7.compactBeforeStep(stepEvent(10, [...(head ?? []), step2]))
    ).toBeUndefined();
  });

  it("is off without config", () => {
    const { guard } = overflow(undefined);
    expect(guard.reactiveEnabled).toBe(false);
    expect(guard.maxRetries).toBe(1);
    expect(guard.isRecoverable("context_overflow")).toBe(false);
  });

  it("reads the provider's error when no classifier is overridden, with no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { guard } = overflow(
      { reactive: true },
      { classifierOverridden: () => false }
    );
    const classification = guard.classifyStreamError(
      new Error("prompt is too long: 210000 tokens > 200000 maximum"),
      "r"
    );
    expect(classification).toBe("context_overflow");
    expect(guard.isRecoverable(classification)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lets the app's classifier win over the provider's error", () => {
    const { guard } = overflow({ reactive: true }, { classify: () => "fatal" });
    expect(
      guard.classifyStreamError(new Error("prompt is too long"), "r")
    ).toBe("fatal");
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
        new TransientChatStreamError("x", null),
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

  it("keeps a step's tool result that repeats the one its continuation started from", async () => {
    const { guard } = overflow({ proactive: { maxInputTokens: 100 } });
    const call: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "check_status",
          input: {}
        }
      ]
    };
    const result: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "check_status",
          output: { type: "text", value: "pending" }
        }
      ]
    };
    const prompt: ModelMessage[] = [
      { role: "user", content: "check it" },
      call,
      result
    ];
    guard.beginRun(prompt);
    // The step's own call and result, the same as the prompt's last two.
    const step = [...prompt, structuredClone(call), structuredClone(result)];
    expect(await guard.compactBeforeStep(stepEvent(95, step))).toEqual([
      { role: "user", content: "summary" },
      call,
      result
    ]);
  });

  it("compacts before a step over budget and keeps the in-flight tail", async () => {
    const { guard, emitted } = overflow({ proactive: { maxInputTokens: 100 } });
    const head: ModelMessage = { role: "user", content: "old" };
    const step: ModelMessage = { role: "assistant", content: "in flight" };
    guard.beginRun([head]);
    expect(await guard.compactBeforeStep(stepEvent(50, [head, step]))).toBe(
      undefined
    );
    expect(await guard.compactBeforeStep(stepEvent(95, [head, step]))).toEqual([
      { role: "user", content: "summary" },
      step
    ]);
    // The default cap is one compaction per run: a later step doesn't
    // compact again, but still gets the compacted head when its messages
    // aren't the override (as on AI SDK 6).
    expect(await guard.compactBeforeStep(stepEvent(95, [head, step]))).toEqual([
      { role: "user", content: "summary" },
      step
    ]);
    expect(
      emitted.filter(([type]) => type === "chat:context:compacted")
    ).toHaveLength(1);
    guard.beginRun([head]);
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
