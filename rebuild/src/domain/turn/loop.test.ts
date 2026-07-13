import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AbortedError } from "../../kernel/errors.js";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createFakeModel } from "../../adapters/memory/fake-model.js";
import type { ModelChunk, ModelClient, ModelRequest } from "../../ports/model.js";
import { userMessage } from "../messages/model.js";
import { assembleTools } from "../tools/registry.js";
import { tool } from "../tools/types.js";
import type { UiChunk } from "../stream/chunks.js";
import { createTurnEngine, StallError, type TurnContext } from "./loop.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function counterIdSource(): IdSource {
  let n = 0;
  return {
    newId(prefix: string): string {
      n += 1;
      return `${prefix}_${n}`;
    },
  };
}

function makeDeps() {
  const clock = createTestClock();
  const ids = counterIdSource();
  const events: ObservabilityEvent[] = [];
  const bus = createEventBus({ agent: "Think", name: "test" });
  bus.subscribe("*", (e) => events.push(e));
  return { clock, ids, bus, events };
}

function baseContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req_1",
    trigger: "chat",
    continuation: false,
    messages: [userMessage("hello")],
    ...overrides,
  };
}

function collector(): { chunks: UiChunk[]; emit: (c: UiChunk) => void } {
  const chunks: UiChunk[] = [];
  return { chunks, emit: (c) => chunks.push(c) };
}

/** Manually-controlled fake timer harness, injected via createTurnEngine deps. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const setTimeoutFn = ((fn: () => void, _ms?: number) => {
    const id = nextId++;
    pending.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    pending.delete(id as number);
  }) as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    pendingCount: () => pending.size,
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

function echoTool() {
  return tool<{ v: number }, { result: number }>({
    description: "echo",
    inputSchema: z.object({ v: z.number() }),
    execute: (input) => ({ result: input.v }),
  });
}

// ---------------------------------------------------------------------------
// 1. single text turn
// ---------------------------------------------------------------------------

describe("createTurnEngine — single text turn", () => {
  it("emits start, delta(s), finish in order and returns a completed outcome", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([{ kind: "text", text: "hi there" }]);
    const tools = assembleTools({}, { clock });
    const { chunks, emit } = collector();

    const outcome = await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      emit,
    });

    expect(chunks[0]).toEqual({ type: "start", messageId: "msg_1" });
    expect(chunks.some((c) => c.type === "text-delta")).toBe(true);
    expect(chunks[chunks.length - 1]).toEqual({ type: "finish", finishReason: "stop" });
    expect(outcome).toMatchObject({ kind: "completed", finishReason: "stop" });
    if (outcome.kind === "completed") {
      expect(outcome.steps).toHaveLength(1);
      expect(outcome.steps[0]?.text).toBe("hi there");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. tool round-trip
// ---------------------------------------------------------------------------

describe("createTurnEngine — tool round-trip", () => {
  it("executes a tool call and the second model call sees the tool result", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([
      { kind: "tool-call", toolName: "echo", input: { v: 7 }, id: "call_1" },
      { kind: "text", text: "done" },
    ]);
    const tools = assembleTools({ builtin: { echo: echoTool() } }, { clock });
    const { emit } = collector();

    const outcome = await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      emit,
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.steps).toHaveLength(2);
    }
    expect(model.requests).toHaveLength(2);
    const secondRequestMessages = model.requests[1]?.messages ?? [];
    const toolMsg = secondRequestMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (toolMsg && toolMsg.role === "tool") {
      expect(toolMsg.content[0]).toMatchObject({
        toolCallId: "call_1",
        toolName: "echo",
        output: { result: 7 },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. maxSteps cap; stopWhen composed
// ---------------------------------------------------------------------------

describe("createTurnEngine — maxSteps and stopWhen", () => {
  it("stops at maxSteps, preserving the last step's finishReason", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel((_req, call) => ({
      kind: "tool-call",
      toolName: "echo",
      input: { v: call },
      id: `call_${call}`,
    }));
    const tools = assembleTools({ builtin: { echo: echoTool() } }, { clock });
    const { emit } = collector();

    const outcome = await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      config: { maxSteps: 3 },
      emit,
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.steps).toHaveLength(3);
      expect(outcome.finishReason).toBe("tool-calls");
    }
  });

  it("stopWhen fires early without exceeding maxSteps", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel((_req, call) => ({
      kind: "tool-call",
      toolName: "echo",
      input: { v: call },
      id: `call_${call}`,
    }));
    const tools = assembleTools({ builtin: { echo: echoTool() } }, { clock });
    const { emit } = collector();

    const outcome = await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      config: { maxSteps: 10, stopWhen: ({ steps }) => steps.length >= 2 },
      emit,
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.steps).toHaveLength(2);
    }
  });

  it("stopWhen never lets the loop exceed maxSteps", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel((_req, call) => ({
      kind: "tool-call",
      toolName: "echo",
      input: { v: call },
      id: `call_${call}`,
    }));
    const tools = assembleTools({ builtin: { echo: echoTool() } }, { clock });
    const { emit } = collector();

    const outcome = await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      config: { maxSteps: 2, stopWhen: () => false },
      emit,
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.steps).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. beforeTurn / beforeStep overrides
// ---------------------------------------------------------------------------

describe("createTurnEngine — beforeTurn / beforeStep overrides", () => {
  it("beforeTurn can swap the model and override the system prompt", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const defaultModel = createFakeModel([{ kind: "text", text: "unused" }]);
    const overrideModel = createFakeModel([{ kind: "text", text: "used" }]);
    const tools = assembleTools({}, { clock });
    const { emit } = collector();

    const outcome = await engine.run({
      context: baseContext(),
      system: "default sys",
      tools,
      model: defaultModel,
      hooks: { beforeTurn: () => ({ model: overrideModel, system: "override sys" }) },
      emit,
    });

    expect(outcome.kind).toBe("completed");
    expect(defaultModel.requests).toHaveLength(0);
    expect(overrideModel.requests).toHaveLength(1);
    expect(overrideModel.requests[0]?.system).toBe("override sys");
  });

  it("beforeStep narrows activeTools for that step's request", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([{ kind: "text", text: "ok" }]);
    const a = tool({ description: "a", inputSchema: z.object({}) });
    const b = tool({ description: "b", inputSchema: z.object({}) });
    const tools = assembleTools({ builtin: { a, b } }, { clock });
    const { emit } = collector();

    await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      hooks: { beforeStep: () => ({ activeTools: ["a"] }) },
      emit,
    });

    expect(model.requests[0]?.tools.map((d) => d.name)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// 5. sendReasoning
// ---------------------------------------------------------------------------

describe("createTurnEngine — sendReasoning", () => {
  it("suppresses reasoning UiChunks when sendReasoning is false, but onChunk still sees raw reasoning chunks", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([{ kind: "text", text: "answer", reasoning: "thinking" }]);
    const tools = assembleTools({}, { clock });
    const { chunks, emit } = collector();
    const rawChunks: ModelChunk[] = [];

    await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      config: { sendReasoning: false },
      hooks: { onChunk: ({ chunk }) => { rawChunks.push(chunk); } },
      emit,
    });

    expect(chunks.some((c) => c.type === "reasoning-delta")).toBe(false);
    expect(rawChunks.some((c) => c.type === "reasoning-delta")).toBe(true);
  });

  it("forwards reasoning UiChunks by default", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([{ kind: "text", text: "answer", reasoning: "thinking" }]);
    const tools = assembleTools({}, { clock });
    const { chunks, emit } = collector();

    await engine.run({ context: baseContext(), system: "sys", tools, model, emit });

    expect(chunks.some((c) => c.type === "reasoning-delta")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. block/substitute decisions visible to the model as outputs
// ---------------------------------------------------------------------------

describe("createTurnEngine — block/substitute tool decisions", () => {
  it("a substitute decision's output is what the model sees as the tool result", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([
      { kind: "tool-call", toolName: "echo", input: { v: 1 }, id: "call_1" },
      { kind: "text", text: "done" },
    ]);
    const tools = assembleTools(
      { builtin: { echo: echoTool() } },
      { clock, hooks: { beforeToolCall: () => ({ action: "substitute", output: { cached: true } }) } }
    );
    const { emit } = collector();

    await engine.run({ context: baseContext(), system: "sys", tools, model, emit });

    const secondRequestMessages = model.requests[1]?.messages ?? [];
    const toolMsg = secondRequestMessages.find((m) => m.role === "tool");
    if (toolMsg && toolMsg.role === "tool") {
      expect(toolMsg.content[0]?.output).toEqual({ cached: true });
    } else {
      throw new Error("expected a tool-result message in the second request");
    }
  });

  it("a block decision's output is what the model sees as the tool result", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([
      { kind: "tool-call", toolName: "echo", input: { v: 1 }, id: "call_1" },
      { kind: "text", text: "done" },
    ]);
    const tools = assembleTools(
      { builtin: { echo: echoTool() } },
      { clock, hooks: { beforeToolCall: () => ({ action: "block", reason: "nope" }) } }
    );
    const { emit } = collector();

    await engine.run({ context: baseContext(), system: "sys", tools, model, emit });

    const secondRequestMessages = model.requests[1]?.messages ?? [];
    const toolMsg = secondRequestMessages.find((m) => m.role === "tool");
    if (toolMsg && toolMsg.role === "tool") {
      expect(toolMsg.content[0]?.output).toEqual({ blocked: true, reason: "nope" });
    } else {
      throw new Error("expected a tool-result message in the second request");
    }
  });
});

// ---------------------------------------------------------------------------
// 7/8. client tool / approval suspension
// ---------------------------------------------------------------------------

describe("createTurnEngine — suspension", () => {
  it("a client tool call suspends the turn with the pending call", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([{ kind: "tool-call", toolName: "client_tool", input: { x: 1 }, id: "call_c" }]);
    const clientTool = tool({ description: "client", inputSchema: z.object({ x: z.number() }) });
    const tools = assembleTools({ client: { client_tool: clientTool } }, { clock });
    const { chunks, emit } = collector();

    const outcome = await engine.run({ context: baseContext(), system: "sys", tools, model, emit });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind === "suspended") {
      expect(outcome.reason).toBe("client-tool");
      expect(outcome.pending).toEqual([{ toolCallId: "call_c", toolName: "client_tool", input: { x: 1 } }]);
    }
    expect(chunks[chunks.length - 1]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "call_c",
      executor: "client",
    });
    expect(chunks.some((c) => c.type === "finish")).toBe(false);
  });

  it("a needsApproval tool call suspends the turn with reason approval", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([{ kind: "tool-call", toolName: "dangerous", input: { x: 1 }, id: "call_d" }]);
    const dangerous = tool({
      description: "dangerous",
      inputSchema: z.object({ x: z.number() }),
      execute: (i: { x: number }) => i.x,
      needsApproval: true,
    });
    const tools = assembleTools({ builtin: { dangerous } }, { clock });
    const { chunks, emit } = collector();

    const outcome = await engine.run({ context: baseContext(), system: "sys", tools, model, emit });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind === "suspended") {
      expect(outcome.reason).toBe("approval");
      expect(outcome.pending).toEqual([{ toolCallId: "call_d", toolName: "dangerous", input: { x: 1 } }]);
    }
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "tool-approval-requested", toolCallId: "call_d" });
  });
});

// ---------------------------------------------------------------------------
// 9. abort mid-stream
// ---------------------------------------------------------------------------

describe("createTurnEngine — abort", () => {
  it("aborting mid-stream yields an aborted outcome with no further chunks", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const controller = new AbortController();
    const model = createFakeModel([
      { kind: "custom", chunks: [{ type: "text-delta", text: "a" }, { type: "text-delta", text: "b" }, { type: "finish", finishReason: "stop" }] },
    ]);
    const tools = assembleTools({}, { clock });
    const { chunks, emit } = collector();
    let sawFirstDelta = false;

    const outcome = await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      signal: controller.signal,
      hooks: {
        onChunk: () => {
          if (!sawFirstDelta) {
            sawFirstDelta = true;
            controller.abort();
          }
        },
      },
      emit,
    });

    expect(outcome.kind).toBe("aborted");
    expect(chunks.filter((c) => c.type === "text-delta")).toHaveLength(1);
    expect(chunks.some((c) => c.type === "finish")).toBe(false);
  });

  it("a tool that throws AbortedError propagates as an aborted outcome", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const model = createFakeModel([{ kind: "tool-call", toolName: "aborting", input: {}, id: "call_1" }]);
    const aborting = tool({
      description: "aborting",
      inputSchema: z.object({}),
      execute: () => {
        throw new AbortedError("cancelled by test");
      },
    });
    const tools = assembleTools({ builtin: { aborting } }, { clock });
    const { emit } = collector();

    const outcome = await engine.run({ context: baseContext(), system: "sys", tools, model, emit });

    expect(outcome.kind).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// 10. stall watchdog
// ---------------------------------------------------------------------------

describe("createTurnEngine — stall watchdog", () => {
  it("fires a StallError outcome and emits chat:stream:stalled when the model hangs", async () => {
    const { clock, ids, bus, events } = makeDeps();
    const timers = fakeTimers();
    const engine = createTurnEngine({ clock, ids, bus, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    const model = createFakeModel([{ kind: "hang" }]);
    const tools = assembleTools({}, { clock });
    const { emit } = collector();

    const outcomePromise = engine.run({
      context: baseContext({ requestId: "req_stall" }),
      system: "sys",
      tools,
      model,
      config: { stallTimeoutMs: 100 },
      emit,
    });

    // Give the run() call a tick to register its watchdog timer, then fire it.
    await Promise.resolve();
    await Promise.resolve();
    timers.fireAll();

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.stalled).toBe(true);
      expect(outcome.error).toBeInstanceOf(StallError);
    }
    const stalledEvent = events.find((e) => e.type === "chat:stream:stalled");
    expect(stalledEvent).toBeDefined();
    expect(stalledEvent?.payload).toMatchObject({ requestId: "req_stall", timeoutMs: 100 });
  });

  it("resets the watchdog timer on each received chunk", async () => {
    const { clock, ids, bus } = makeDeps();
    const timers = fakeTimers();
    const engine = createTurnEngine({ clock, ids, bus, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    // Two deltas + finish => at least 3 iterator.next() calls, each should
    // schedule (and cleanly cancel) its own watchdog timer.
    const model = createFakeModel([{ kind: "text", text: "hello world" }]);
    const tools = assembleTools({}, { clock });
    const { emit } = collector();

    const outcome = await engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      config: { stallTimeoutMs: 100 },
      emit,
    });

    expect(outcome.kind).toBe("completed");
    // Every timer that was scheduled was also cancelled — none left pending.
    expect(timers.pendingCount()).toBe(0);
  });

  it("stallTimeoutMs 0 disables the watchdog entirely", async () => {
    const { clock, ids, bus } = makeDeps();
    const timers = fakeTimers();
    const engine = createTurnEngine({ clock, ids, bus, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    const controller = new AbortController();
    const model = createFakeModel([{ kind: "hang" }]);
    const tools = assembleTools({}, { clock });
    const { emit } = collector();

    const runPromise = engine.run({
      context: baseContext(),
      system: "sys",
      tools,
      model,
      config: { stallTimeoutMs: 0 },
      signal: controller.signal,
      emit,
    });

    const result = await Promise.race([
      runPromise.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(result).toBe("timeout");
    expect(timers.pendingCount()).toBe(0); // no watchdog timer was ever scheduled

    controller.abort();
    const outcome = await runPromise;
    expect(outcome.kind).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// 11. model throw mid-stream
// ---------------------------------------------------------------------------

describe("createTurnEngine — model throws mid-stream", () => {
  it("returns an error outcome; chunks emitted before the throw stand", async () => {
    const { clock, ids, bus } = makeDeps();
    const engine = createTurnEngine({ clock, ids, bus });
    const throwingModel: ModelClient = {
      async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
        yield { type: "text-delta", text: "partial" };
        throw new Error("boom mid-stream");
      },
    };
    const tools = assembleTools({}, { clock });
    const { chunks, emit } = collector();

    const outcome = await engine.run({ context: baseContext(), system: "sys", tools, model: throwingModel, emit });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.stalled).toBeFalsy();
      expect((outcome.error as Error).message).toBe("boom mid-stream");
    }
    expect(chunks.some((c) => c.type === "text-delta" && c.delta === "partial")).toBe(true);
  });
});
