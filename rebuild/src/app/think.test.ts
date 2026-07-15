import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel, type FakeModel, type FakeTurn } from "../adapters/memory/fake-model.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelChunk, ModelClient, ModelRequest } from "../ports/model.js";
import { action, type Action } from "../domain/actions/actions.js";
import type { ChannelDefinition } from "../domain/channels/channels.js";
import type { ConversationEvent, StoredEvent } from "../domain/events/log.js";
import type { ToolSet } from "../domain/tools/types.js";
import type { AgentRuntime } from "./agent.js";
import { Think, type StreamCallback } from "./think.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentRuntime> & { className: string; name: string }): AgentRuntime {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

/** Flexible Think subclass: every overridable is a plain public field the test can set directly. */
class TestThink extends Think<unknown> {
  model!: ModelClient;
  tools: ToolSet = {};
  actions: Record<string, Action> = {};
  channels: Record<string, ChannelDefinition> = {};
  systemPrompt = "You are a test assistant.";
  defaultTimezone: string | undefined;

  protected override getModel(): ModelClient {
    return this.model;
  }
  protected override getSystemPrompt(): string {
    return this.systemPrompt;
  }
  protected override getTools(): ToolSet {
    return this.tools;
  }
  protected override getActions(): Record<string, Action> {
    return this.actions;
  }
  protected override configureChannels(): Record<string, ChannelDefinition> {
    return this.channels;
  }
  protected override getDefaultTimezone(): string | undefined {
    return this.defaultTimezone;
  }
}

function makeThink(script: FakeTurn[] | ((req: ModelRequest, call: number) => FakeTurn)): {
  agent: TestThink;
  mem: MemoryHost;
  model: FakeModel;
} {
  const mem = createMemoryHost({ agent: "TestThink", name: "a1" });
  const host = toHost(mem, { className: "TestThink", name: "a1" });
  const agent = new TestThink(host);
  mem.attachAgent(agent);
  const model = createFakeModel(script);
  agent.model = model;
  return { agent, mem, model };
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Collects every ConversationEvent published from "live" onward. */
function collectEvents(agent: Think<unknown>): StoredEvent[] {
  const collected: StoredEvent[] = [];
  agent.events().subscribe("live", (e) => collected.push(e));
  return collected;
}

function eventsOfType<T extends ConversationEvent["type"]>(
  events: StoredEvent[],
  type: T,
): Array<Extract<ConversationEvent, { type: T }>> {
  return events.map((e) => e.event).filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);
}

/** A model stream whose chunks are pushed in by the test, for genuine mid-stream concurrency tests. */
function controllableModel(): { model: ModelClient; push: (chunk: ModelChunk) => void; finish: () => void } {
  const queue: ModelChunk[] = [];
  let resolvers: Array<(v: IteratorResult<ModelChunk>) => void> = [];
  let done = false;

  function push(chunk: ModelChunk): void {
    const waiter = resolvers.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else queue.push(chunk);
  }
  function finish(): void {
    done = true;
    for (const waiter of resolvers.splice(0)) waiter({ value: undefined as unknown as ModelChunk, done: true });
  }

  const model: ModelClient = {
    async *stream(): AsyncIterable<ModelChunk> {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) return;
        const next = await new Promise<IteratorResult<ModelChunk>>((resolve) => resolvers.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
  return { model, push, finish };
}

// ---------------------------------------------------------------------------
// 1. Text turn end-to-end
// ---------------------------------------------------------------------------

describe("Think — text turn end-to-end", () => {
  it("publishes turn:started/chunk/message:updated/turn:settled events, persists the final message, and history() replays the full transcript", async () => {
    const { agent } = makeThink([{ kind: "text", text: "Hello there" }]);
    await agent.start();

    const events = collectEvents(agent);
    const busEvents: string[] = [];
    agent.bus.subscribe("message", (e) => busEvents.push(e.type));

    const result = await agent.chat("Hi", undefined, { requestId: "req_1" });
    expect(result.outcome).toBe("completed");

    expect(eventsOfType(events, "turn:started")).toHaveLength(1);
    const chunkTypes = eventsOfType(events, "chunk").map((e) => e.chunk.type);
    expect(chunkTypes[0]).toBe("start");
    expect(chunkTypes).toContain("text-delta");
    expect(chunkTypes[chunkTypes.length - 1]).toBe("finish");

    expect(eventsOfType(events, "message:updated").length).toBeGreaterThan(0);
    const settled = eventsOfType(events, "turn:settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ requestId: "req_1", outcome: "completed" });
    expect(busEvents).toContain("message:response");

    const messages = await agent.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    const text = messages[1]!.parts.find((p) => p.type === "text");
    expect(text).toMatchObject({ text: "Hello there" });

    const history = await agent.history();
    expect(history).toHaveLength(2);
  });

  it("chat()'s callback receives onStart/onEvent/onDone through the event-log subscription", async () => {
    const { agent } = makeThink([{ kind: "text", text: "hi" }]);
    await agent.start();

    const starts: unknown[] = [];
    const chunks: unknown[] = [];
    let done = false;
    const callback: StreamCallback = {
      onStart: (info) => starts.push(info),
      onEvent: (json) => chunks.push(json),
      onDone: () => {
        done = true;
      },
      onError: () => {
        throw new Error("unexpected onError");
      },
    };

    await agent.chat("Hi", callback, { requestId: "req_1" });

    expect(starts).toEqual([{ requestId: "req_1" }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. activeTurn() — resume-handshake seam
// ---------------------------------------------------------------------------

describe("Think — activeTurn()", () => {
  it("reports the currently-streaming turn, then clears once it settles", async () => {
    const { model, push, finish } = controllableModel();
    const { agent } = makeThink([]);
    agent.model = model;
    await agent.start();

    expect(agent.activeTurn()).toBeNull();

    push({ type: "text-delta", text: "Hel" });
    const chatPromise = agent.chat("Hi", undefined, { requestId: "req_1" });
    await vi.waitFor(() => expect(agent.activeTurn()).not.toBeNull());

    const active = agent.activeTurn();
    expect(active?.requestId).toBe("req_1");
    expect(typeof active?.startOffset).toBe("number");

    push({ type: "text-delta", text: "lo" });
    push({ type: "finish", finishReason: "stop" });
    finish();
    await chatPromise;

    expect(agent.activeTurn()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Client tool suspension + applyToolResult + auto-continuation
// ---------------------------------------------------------------------------

describe("Think — client tool suspension and auto-continuation", () => {
  it("suspends for a client tool, then continues once applyToolResult() delivers the result", async () => {
    const { agent } = makeThink([
      { kind: "tool-call", toolName: "add", input: { a: 2, b: 3 }, id: "call_1" },
      { kind: "text", text: "Sum is 5" },
    ]);
    agent.tools = {
      add: { description: "adds numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) },
    };
    agent.chatToolResultDebounceMs = 0;
    await agent.start();

    const events = collectEvents(agent);
    await agent.chat("add 2 and 3", undefined, { requestId: "req_1" });

    const chunks = eventsOfType(events, "chunk").map((e) => e.chunk);
    const inputAvailable = chunks.find((c) => c.type === "tool-input-available");
    expect(inputAvailable).toBeDefined();
    expect((inputAvailable as { executor: string }).executor).toBe("client");

    const settled = eventsOfType(events, "turn:settled");
    expect(settled[0]).toMatchObject({ outcome: "suspended", suspendedOn: "client-tool" });

    let messages = await agent.getMessages();
    expect(messages[1]!.parts.find((p) => p.type === "tool-add")).toMatchObject({ state: "input-available" });

    await agent.applyToolResult({ toolCallId: "call_1", output: 5 });
    await vi.waitFor(async () => {
      messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Sum is 5"))).toBe(true);
    });

    const toolPart = messages[1]!.parts.find((p) => p.type === "tool-add");
    expect(toolPart).toMatchObject({ state: "output-available", output: 5 });
  });
});

// ---------------------------------------------------------------------------
// 4. Approval approve / reject
// ---------------------------------------------------------------------------

describe("Think — action approval via resolveApproval()", () => {
  function makeApprovalAgent() {
    const { agent, mem, model } = makeThink([
      { kind: "tool-call", toolName: "dangerous", input: { x: 5 }, id: "call_1" },
      { kind: "text", text: "Handled" },
    ]);
    agent.actions = {
      dangerous: action({
        description: "does something risky",
        inputSchema: z.object({ x: z.number() }),
        approval: true,
        execute: (input: { x: number }) => ({ result: input.x * 2 }),
      }),
    };
    agent.chatToolResultDebounceMs = 0;
    return { agent, mem, model };
  }

  it("approve: executes the action, writes output, and auto-continues", async () => {
    const { agent } = makeApprovalAgent();
    await agent.start();
    const events = collectEvents(agent);

    await agent.chat("do it", undefined, { requestId: "req_1" });
    const approvalRequested = eventsOfType(events, "chunk")
      .map((e) => e.chunk)
      .find((c) => c.type === "tool-approval-requested");
    expect(approvalRequested).toBeDefined();

    await agent.resolveApproval({ toolCallId: "call_1", approved: true });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Handled"))).toBe(true);
    });
    const messages = await agent.getMessages();
    const toolPart = messages[1]!.parts.find((p) => p.type === "tool-dangerous");
    expect(toolPart).toMatchObject({ state: "output-available", output: { result: 10 } });
  });

  it("reject: settles the tool part as output-denied and auto-continues", async () => {
    const { agent } = makeApprovalAgent();
    await agent.start();

    await agent.chat("do it", undefined, { requestId: "req_1" });
    await agent.resolveApproval({ toolCallId: "call_1", approved: false, reason: "no" });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Handled"))).toBe(true);
    });
    const messages = await agent.getMessages();
    const toolPart = messages[1]!.parts.find((p) => p.type === "tool-dangerous");
    expect(toolPart).toMatchObject({ state: "output-denied" });
    expect((toolPart as { errorText: string }).errorText).toContain("no");
  });

  it("durable-pause: parks the execution; approveExecution writes output and auto-continues", async () => {
    const { agent } = makeThink([
      { kind: "tool-call", toolName: "deploy", input: { env: "prod" }, id: "call_1" },
      { kind: "text", text: "Deployed" },
    ]);
    agent.actions = {
      deploy: action({
        description: "deploys",
        inputSchema: z.object({ env: z.string() }),
        approval: true,
        kind: "durable-pause",
        execute: (input: { env: string }) => ({ deployed: input.env }),
      }),
    };
    agent.chatToolResultDebounceMs = 0;
    await agent.start();
    const events = collectEvents(agent);

    const result = await agent.chat("deploy it", undefined, { requestId: "req_1" });
    expect(result.outcome).toBe("suspended");
    expect(eventsOfType(events, "turn:settled")[0]).toMatchObject({ outcome: "suspended", suspendedOn: "durable-pause" });

    const pending = agent.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.descriptor.action).toBe("deploy");

    await agent.approveExecution(pending[0]!.executionId);

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Deployed"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. clearMessages side effects
// ---------------------------------------------------------------------------

describe("Think — clearMessages", () => {
  it("publishes conversation:cleared and empties history", async () => {
    const { agent } = makeThink([{ kind: "text", text: "hi" }]);
    await agent.start();
    await agent.chat("Hi", undefined, { requestId: "req_1" });
    expect(await agent.getMessages()).toHaveLength(2);

    const events = collectEvents(agent);
    await agent.clearMessages();

    expect(eventsOfType(events, "conversation:cleared")).toHaveLength(1);
    expect(await agent.getMessages()).toHaveLength(0);
  });

  it("cancels a running turn", async () => {
    const { agent } = makeThink([{ kind: "hang" }]);
    await agent.start();

    const chatPromise = agent.chat("hi", undefined, { requestId: "req_1" });
    await flushMicrotasks();

    await agent.clearMessages();
    const result = await chatPromise;
    expect(result.outcome).toBe("aborted");
  });

  it("marks pending submissions skipped", async () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeThink([{ kind: "text", text: "hi" }]);
      await agent.start();

      const sub1 = await agent.submitMessages([{ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] }]);
      const sub2 = await agent.submitMessages([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }]);
      expect(sub1.status).toBe("pending");
      expect(sub2.status).toBe("pending");

      await agent.clearMessages();
      await vi.advanceTimersByTimeAsync(50);

      expect(await agent.getMessages()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Channel policy + beforeTurn precedence
// ---------------------------------------------------------------------------

describe("Think — channel policy and beforeTurn precedence", () => {
  function makeChannelAgent() {
    const { agent, mem, model } = makeThink([
      { kind: "tool-call", toolName: "noop", input: {}, id: "call_1" },
      { kind: "text", text: "second call happened" },
    ]);
    agent.tools = {
      noop: { description: "does nothing", inputSchema: z.object({}), execute: () => ({ ok: true }) },
    };
    agent.channels = {
      support: { kind: "custom", instructions: "Be terse.", maxTurns: 1 },
    };
    return { agent, mem, model };
  }

  it("prepends declared channel instructions to the system prompt", async () => {
    const { agent, model } = makeChannelAgent();
    await agent.start();
    await agent.chat("hi", undefined, { requestId: "req_1", channel: "support" });
    expect(model.requests[0]!.system).toContain("Be terse.");
  });

  it("caps steps at the channel's maxTurns", async () => {
    const { agent, model } = makeChannelAgent();
    await agent.start();
    await agent.chat("hi", undefined, { requestId: "req_1", channel: "support" });
    expect(model.requests).toHaveLength(1);
  });

  it("beforeTurn's returned maxSteps overrides the channel's maxTurns", async () => {
    const { agent, model } = makeChannelAgent();
    agent.beforeTurn = () => ({ maxSteps: 5 });
    await agent.start();
    await agent.chat("hi", undefined, { requestId: "req_1", channel: "support" });
    expect(model.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Recovery — recovering-flag basics (deep eviction-recovery replay is left
//    to the e2e wave per the audit's stretch-goal allowance).
// ---------------------------------------------------------------------------

describe("Think — recovery basics", () => {
  it("publishes recovering:changed(active: true) when a stall is detected", async () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeThink([{ kind: "hang" }]);
      agent.chatStreamStallTimeoutMs = 1000;
      await agent.start();
      const events = collectEvents(agent);

      const chatPromise = agent.chat("hi", undefined, { requestId: "req_1" });
      await vi.advanceTimersByTimeAsync(1000);
      await chatPromise;

      const recovering = eventsOfType(events, "recovering:changed");
      expect(recovering.some((e) => e.active === true)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("chatRecovery: false skips fiber wrapping and still completes turns", async () => {
    const { agent } = makeThink([{ kind: "text", text: "no recovery needed" }]);
    agent.chatRecovery = false;
    await agent.start();
    await agent.chat("hi", undefined, { requestId: "req_1" });
    const messages = await agent.getMessages();
    expect(messages[1]!.parts.find((p) => p.type === "text")).toMatchObject({ text: "no recovery needed" });
  });

  it("chatRecovery: false lets a stalled stream fail terminally instead of scheduling recovery", async () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeThink([{ kind: "hang" }]);
      agent.chatRecovery = false;
      agent.chatStreamStallTimeoutMs = 1000;
      await agent.start();

      const resultPromise = agent.chat("hi", undefined, { requestId: "req_1" });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      expect(result.outcome).toBe("error");
      expect(agent.chatRecoverySchedule()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitUntilStable() returns false while a turn is running, then true after it settles", async () => {
    const { model, push, finish } = controllableModel();
    const { agent } = makeThink([]);
    agent.model = model;
    await agent.start();

    const chatPromise = agent.chat("hi", undefined, { requestId: "req_1" });
    await vi.waitFor(() => expect(agent.activeTurn()).not.toBeNull());

    expect(await agent.waitUntilStable({ timeoutMs: 5 })).toBe(false);

    push({ type: "text-delta", text: "done" });
    push({ type: "finish", finishReason: "stop" });
    finish();
    await chatPromise;

    expect(await agent.waitUntilStable({ timeoutMs: 50 })).toBe(true);
  });

  it("waitUntilStable() waits for an armed auto-continuation debounce", async () => {
    const { agent } = makeThink([
      { kind: "tool-call", toolName: "client_task", input: {}, id: "call_1" },
      { kind: "text", text: "continued" },
    ]);
    agent.tools = {
      client_task: { description: "client task", inputSchema: z.object({}) },
    };
    agent.chatToolResultDebounceMs = 50;
    await agent.start();

    await agent.chat("use the client", undefined, { requestId: "req_1" });
    await agent.applyToolResult({ toolCallId: "call_1", output: "ok" });

    expect(await agent.waitUntilStable({ timeoutMs: 5 })).toBe(false);
    await vi.waitFor(async () => {
      expect(await agent.waitUntilStable({ timeoutMs: 10 })).toBe(true);
    });
  });

  it("chatRecoveryIncidents() lists the active durable recovery incident", async () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeThink([{ kind: "hang" }, { kind: "hang" }]);
      agent.chatStreamStallTimeoutMs = 1000;
      await agent.start();

      const chatPromise = agent.chat("hi", undefined, { requestId: "req_1" });
      await vi.advanceTimersByTimeAsync(1000);
      await chatPromise;

      expect(agent.chatRecoveryIncidents()).toEqual([
        expect.objectContaining({
          requestId: "req_1",
          attempt: 1,
          recoveryKind: "continue",
        }),
      ]);
      agent.cancelAllChats("test cleanup");
    } finally {
      vi.useRealTimers();
    }
  });

  it("chatRecoverySchedule() lists scheduled or in-flight recovery attempts", async () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeThink([{ kind: "hang" }, { kind: "hang" }]);
      agent.chatStreamStallTimeoutMs = 1000;
      await agent.start();

      const chatPromise = agent.chat("hi", undefined, { requestId: "req_1" });
      await vi.advanceTimersByTimeAsync(1000);
      await chatPromise;

      expect(agent.chatRecoverySchedule()).toEqual([
        expect.objectContaining({
          requestId: "req_1",
          attempt: 1,
          recoveryKind: "continue",
          scheduledAt: expect.any(Number),
        }),
      ]);
      agent.cancelAllChats("test cleanup");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal response hooks and failure telemetry
// ---------------------------------------------------------------------------

describe("Think — terminal response reporting", () => {
  it("fires onChatResponse with error status and emits chat:request:failed for in-band stream errors", async () => {
    const { agent } = makeThink([
      {
        kind: "custom",
        chunks: [
          { type: "text-delta", text: "partial" },
          { type: "error", error: new Error("provider failed") },
        ],
      },
    ]);
    await agent.start();
    const responses: unknown[] = [];
    const failures: unknown[] = [];
    agent.onChatResponse = (result) => {
      responses.push(result);
    };
    agent.bus.subscribe("chat", (event) => {
      if (event.type === "chat:request:failed") failures.push(event.payload);
    });

    const result = await agent.chat("hi", undefined, { requestId: "req_1" });

    expect(result.outcome).toBe("error");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: "req_1",
      status: "error",
      error: "provider failed",
      continuation: false,
    });
    expect(failures).toContainEqual(
      expect.objectContaining({
        requestId: "req_1",
        stage: "stream",
        messagesPersisted: true,
        error: "provider failed",
      }),
    );
  });

  it("fires onChatResponse with aborted status for cancelled turns", async () => {
    const { agent } = makeThink([{ kind: "hang" }]);
    await agent.start();
    const responses: unknown[] = [];
    agent.onChatResponse = (result) => {
      responses.push(result);
    };

    const chatPromise = agent.chat("hi", undefined, { requestId: "req_1" });
    await flushMicrotasks();
    expect(agent.cancelChat("req_1", "stop now")).toBe(true);
    const result = await chatPromise;

    expect(result.outcome).toBe("aborted");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: "req_1",
      status: "aborted",
      error: "stop now",
      continuation: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Config surface basics
// ---------------------------------------------------------------------------

describe("Think — config surface", () => {
  it("getModel() throws by default, surfaced as an error chunk and a failed turn:settled", async () => {
    class DefaultThink extends Think<unknown> {}
    const mem = createMemoryHost({ agent: "DefaultThink", name: "a1" });
    const host = toHost(mem, { className: "DefaultThink", name: "a1" });
    const agent = new DefaultThink(host);
    await agent.start();
    const events = collectEvents(agent);

    await agent.chat("hi", undefined, { requestId: "req_1" });

    const errorChunks = eventsOfType(events, "chunk").filter((e) => e.chunk.type === "error");
    expect(errorChunks.length).toBeGreaterThan(0);
    expect(eventsOfType(events, "turn:settled")[0]).toMatchObject({ outcome: "failed" });
  });

  it("configure()/getConfig() persist a server-private blob", async () => {
    const { agent } = makeThink([]);
    agent.configure({ hello: "world" });
    expect(agent.getConfig()).toEqual({ hello: "world" });
  });

  it("agent-tool surface throws without a spawner", () => {
    const { agent } = makeThink([]);
    expect(() => agent.inspectAgentToolRun("run_1")).toThrow(/AgentSpawner/);
  });

  it("identity() reports className and name (inherited from Agent)", () => {
    const { agent } = makeThink([]);
    expect(agent.identity()).toEqual({ className: "TestThink", name: "a1" });
  });
});
