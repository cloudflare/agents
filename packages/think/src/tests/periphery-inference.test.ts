import type { ModelMessage, UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createInferenceInvocation } from "../inference/invocation";
import { createMockModel } from "./agents/think-session";
import {
  drainInferenceStream,
  streamErrorToString
} from "../inference/invocation";
import {
  MODEL_RECENT_WINDOW,
  ensureValidContinueCheckpoint,
  mediaEvictionCutoff,
  modelMessagesFromHistory,
  toProviderSafeExecutionOutcomeMessage,
  truncationKeepRecent,
  withContextReminder
} from "../inference/model-messages";
import {
  isThinkFinalAnswerToolName,
  thinkFinalAnswerInstruction
} from "../inference/structured-output";
import { turnTelemetryV6, turnTelemetryV7 } from "../inference/telemetry";

const text = (id: string, role: UIMessage["role"], value: string) =>
  ({ id, role, parts: [{ type: "text", text: value }] }) as UIMessage;

describe("read-time truncation", () => {
  it("keeps the recent window, stepping the cutoff", () => {
    expect(truncationKeepRecent(2, 8)).toBe(MODEL_RECENT_WINDOW);
    expect(truncationKeepRecent(4, 8)).toBe(4);
    expect(truncationKeepRecent(5, 8)).toBe(5);
    expect(truncationKeepRecent(12, 8)).toBe(4);
    expect(truncationKeepRecent(13, 8)).toBe(5);
  });

  it("never moves the cutoff with an infinite step", () => {
    expect(truncationKeepRecent(40, Number.POSITIVE_INFINITY)).toBe(40);
    expect(mediaEvictionCutoff(40, 8, Number.POSITIVE_INFINITY)).toBe(32);
  });

  it("treats an invalid step as one", () => {
    expect(truncationKeepRecent(10, 0)).toBe(4);
    expect(truncationKeepRecent(10, Number.NaN)).toBe(4);
  });

  it("puts the eviction cutoff below the truncation cutoff", () => {
    const cutoff = mediaEvictionCutoff(30, 8, 8);
    expect(cutoff).toBeLessThanOrEqual(30 - truncationKeepRecent(30, 8));
    expect(30 - cutoff).toBeGreaterThanOrEqual(8);
  });
});

describe("request shaping", () => {
  it("adds a continue checkpoint after a trailing assistant message", () => {
    const user: ModelMessage = { role: "user", content: "hi" };
    const assistant: ModelMessage = { role: "assistant", content: "par" };
    expect(ensureValidContinueCheckpoint([user])).toEqual([user]);
    const checked = ensureValidContinueCheckpoint([user, assistant]);
    expect(checked).toHaveLength(3);
    expect(checked[2].role).toBe("user");
    expect(ensureValidContinueCheckpoint([])).toEqual([]);
  });

  it("carries the reminder inside the last user message", () => {
    const [joined] = withContextReminder(
      [{ role: "user", content: "hi" }],
      "remember"
    );
    expect(joined.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "remember" }
    ]);
    expect(
      withContextReminder([{ role: "user", content: "hi" }], null)
    ).toEqual([{ role: "user", content: "hi" }]);
  });

  it("gives a trailing assistant message the checkpoint with the reminder", () => {
    const out = withContextReminder(
      [{ role: "assistant", content: "par" }],
      "remember"
    );
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe("user");
    expect(ensureValidContinueCheckpoint(out)).toBe(out);
  });

  it("shows execution outcome notes to providers as user messages", () => {
    const note = text("exec-outcome-1", "system", "done");
    expect(toProviderSafeExecutionOutcomeMessage(note).role).toBe("user");
    const other = text("sys", "system", "x");
    expect(toProviderSafeExecutionOutcomeMessage(other)).toBe(other);
  });
});

describe("modelMessagesFromHistory", () => {
  const options = {
    tools: {},
    truncationStep: 8,
    incompleteToolCallIds: () => [],
    onIncompleteToolCalls: vi.fn()
  };

  it("converts the repaired history", async () => {
    const messages = await modelMessagesFromHistory(
      {
        messages: [text("1", "user", "hi"), text("2", "assistant", "hello")],
        keptToolCallIds: []
      } as never,
      options
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(options.onIncompleteToolCalls).not.toHaveBeenCalled();
  });

  it("refuses a history that still waits on a client tool", async () => {
    await expect(
      modelMessagesFromHistory(
        { messages: [], keptToolCallIds: ["call-1"] } as never,
        options
      )
    ).rejects.toThrow(/call-1/);
  });

  it("reports calls that survived repair", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onIncompleteToolCalls = vi.fn();
    await modelMessagesFromHistory(
      { messages: [text("1", "user", "hi")], keptToolCallIds: [] } as never,
      {
        ...options,
        incompleteToolCallIds: () => ["lost"],
        onIncompleteToolCalls
      }
    );
    expect(onIncompleteToolCalls).toHaveBeenCalledWith(["lost"]);
    warn.mockRestore();
  });
});

describe("structured output", () => {
  it("recognises the final-answer tool and its suffixed names", () => {
    expect(isThinkFinalAnswerToolName("think_final_answer")).toBe(true);
    expect(isThinkFinalAnswerToolName("think_final_answer_2")).toBe(true);
    expect(isThinkFinalAnswerToolName("final_answer")).toBe(false);
    expect(thinkFinalAnswerInstruction("t")).toContain("`t`");
  });
});

describe("turn telemetry", () => {
  const identity = {
    className: "MyAgent",
    agentId: "room-1",
    conversationId: "do-id",
    turn: {
      requestId: "req",
      trigger: "rpc",
      admission: "queue",
      channel: "web"
    }
  };

  it("names the agent and turn, and lets the caller win", () => {
    const settings = turnTelemetryV6(
      { isEnabled: true, metadata: { agentId: "override" } } as never,
      identity
    ) as unknown as Record<string, unknown>;
    expect(settings.functionId).toBe("MyAgent");
    expect(settings.metadata).toEqual({
      agentId: "override",
      conversationId: "do-id",
      "cloudflare.agents.turn.request_id": "req",
      "cloudflare.agents.turn.trigger": "rpc",
      "cloudflare.agents.turn.admission": "queue",
      "cloudflare.agents.turn.channel": "web"
    });
  });

  it("keeps an explicit functionId", () => {
    const settings = turnTelemetryV6({ functionId: "custom" } as never, {
      ...identity,
      turn: undefined
    }) as unknown as Record<string, unknown>;
    expect(settings.functionId).toBe("custom");
    expect(settings.metadata).toEqual({
      agentId: "room-1",
      conversationId: "do-id"
    });
  });

  it("builds v7 options with the runtime context included", () => {
    const { options, runtimeContext } = turnTelemetryV7(
      {
        metadata: { extra: 1 },
        includeRuntimeContext: { extra: false }
      } as never,
      identity
    );
    expect(runtimeContext.extra).toBe(1);
    expect(options.metadata).toBeUndefined();
    expect(options.includeRuntimeContext).toMatchObject({
      agentId: true,
      extra: false
    });
    expect(options.integrations).toEqual([]);
  });
});

describe("inference stream helpers", () => {
  it("turns any stream error into text", () => {
    expect(streamErrorToString(new Error("boom"))).toBe("boom");
    expect(streamErrorToString("plain")).toBe("plain");
    expect(streamErrorToString({ code: 1 })).toBe('{"code":1}');
  });

  it("ignores a result it never registered", () => {
    const waitUntil = vi.fn();
    drainInferenceStream({}, waitUntil);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("drains a registered stream once, through either result", async () => {
    let wrapper: object | undefined;
    const invoke = createInferenceInvocation({
      config: {},
      model: createMockModel("hello"),
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      maxSteps: 1,
      sendReasoning: false,
      continuation: false,
      telemetry: { className: "T", agentId: "a", conversationId: "c" },
      invocationBounded: false,
      storeMessages: false,
      storeTools: false,
      hooks: {
        compactBeforeStep: async () => undefined,
        beforeStep: () => undefined,
        onChunk: async () => {},
        onStepEnd: async () => {},
        afterToolCall: async () => {},
        requestId: () => undefined,
        resolveModel: () => createMockModel("x"),
        transformResult: (result) => (wrapper = { ...result })
      }
    });
    const result = invoke();
    expect(result).toBe(wrapper);
    const drains: Promise<void>[] = [];
    drainInferenceStream(result, (promise) => drains.push(promise));
    drainInferenceStream(result, (promise) => drains.push(promise));
    expect(drains).toHaveLength(1);
    await drains[0];
  });
});
