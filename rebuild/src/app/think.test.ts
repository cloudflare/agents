import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryConnection, type MemoryConnection } from "../adapters/memory/transport.js";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel, type FakeModel, type FakeTurn } from "../adapters/memory/fake-model.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelChunk, ModelClient, ModelRequest } from "../ports/model.js";
import { action, type Action } from "../domain/actions/actions.js";
import type { ChannelDefinition } from "../domain/channels/channels.js";
import type { ChatMessage } from "../domain/messages/model.js";
import type { ToolSet } from "../domain/tools/types.js";
import type { AgentHost } from "./agent.js";
import { Think, type StreamCallback } from "./think.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    connections: mem.connections,
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

function connectionFrames(conn: MemoryConnection): unknown[] {
  return conn.sent.map((s) => JSON.parse(s));
}

function framesOfType(conn: MemoryConnection, type: string): Array<Record<string, unknown>> {
  return connectionFrames(conn).filter((f): f is Record<string, unknown> => (f as { type?: unknown }).type === type);
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
  it("streams chunk frames, persists the final message, and replays full history on reconnect", async () => {
    const { agent, mem } = makeThink([{ kind: "text", text: "Hello there" }]);
    await agent.start();

    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onConnect(conn);

    const events: string[] = [];
    agent.events.subscribe("message", (e) => events.push(e.type));

    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "Hi" }));

    const responseFrames = framesOfType(conn, "cf_agent_use_chat_response");
    const chunkTypes = responseFrames.map((f) => (f.chunk as { type: string }).type);
    expect(chunkTypes[0]).toBe("start");
    expect(chunkTypes).toContain("text-delta");
    expect(chunkTypes[chunkTypes.length - 1]).toBe("finish");

    expect(framesOfType(conn, "cf_agent_message_updated").length).toBeGreaterThan(0);
    expect(events).toContain("message:response");

    const messages = await agent.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    const text = messages[1]!.parts.find((p) => p.type === "text");
    expect(text).toMatchObject({ text: "Hello there" });

    const conn2 = createMemoryConnection("c2");
    mem.connections.add(conn2);
    await agent.onConnect(conn2);
    const sync = framesOfType(conn2, "cf_agent_chat_messages");
    expect(sync).toHaveLength(1);
    expect(sync[0]!.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Resume handshake
// ---------------------------------------------------------------------------

describe("Think — resume handshake", () => {
  it("replays a recently-settled stream with replay:true on request", async () => {
    const { agent, mem } = makeThink([{ kind: "text", text: "Done" }]);
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "Hi" }));

    const conn2 = createMemoryConnection("c2");
    mem.connections.add(conn2);
    await agent.onMessage(conn2, JSON.stringify({ type: "cf_agent_stream_resume_request", id: "req_1" }));

    const resuming = framesOfType(conn2, "cf_agent_stream_resuming");
    expect(resuming).toHaveLength(1);
    const replayed = framesOfType(conn2, "cf_agent_use_chat_response");
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((f) => f.replay === true)).toBe(true);
  });

  it("replays a still-active stream live and reports resume_none for an unknown id", async () => {
    const { model, push, finish } = controllableModel();
    const mem = createMemoryHost({ agent: "TestThink", name: "a1" });
    const host = toHost(mem, { className: "TestThink", name: "a1" });
    const agent = new TestThink(host);
    agent.model = model;
    await agent.start();

    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);

    push({ type: "text-delta", text: "Hel" });
    const chatPromise = agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "Hi" }));
    await flushMicrotasks();

    const conn2 = createMemoryConnection("c2");
    mem.connections.add(conn2);
    await agent.onMessage(conn2, JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    expect(framesOfType(conn2, "cf_agent_stream_resuming")).toHaveLength(1);
    expect(framesOfType(conn2, "cf_agent_use_chat_response").length).toBeGreaterThan(0);

    push({ type: "text-delta", text: "lo" });
    push({ type: "finish", finishReason: "stop" });
    finish();
    await chatPromise;

    const conn3 = createMemoryConnection("c3");
    mem.connections.add(conn3);
    await agent.onMessage(conn3, JSON.stringify({ type: "cf_agent_stream_resume_request", id: "unknown_id" }));
    expect(framesOfType(conn3, "cf_agent_stream_resume_none")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Client tool suspension + tool_result + auto-continuation
// ---------------------------------------------------------------------------

describe("Think — client tool suspension and auto-continuation", () => {
  it("suspends for a client tool, then continues once the result arrives", async () => {
    const { agent, mem } = makeThink([
      { kind: "tool-call", toolName: "add", input: { a: 2, b: 3 }, id: "call_1" },
      { kind: "text", text: "Sum is 5" },
    ]);
    agent.tools = {
      add: { description: "adds numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) },
    };
    agent.chatToolResultDebounceMs = 0;
    await agent.start();

    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "add 2 and 3" }));

    const inputAvailable = framesOfType(conn, "cf_agent_use_chat_response").find(
      (f) => (f.chunk as { type: string }).type === "tool-input-available",
    );
    expect(inputAvailable).toBeDefined();
    expect((inputAvailable!.chunk as { executor: string }).executor).toBe("client");

    let messages = await agent.getMessages();
    expect(messages[1]!.parts.find((p) => p.type === "tool-add")).toMatchObject({ state: "input-available" });

    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_tool_result", toolCallId: "call_1", output: 5 }));
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

describe("Think — action approval frame", () => {
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
    const { agent, mem } = makeApprovalAgent();
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "do it" }));

    const approvalRequested = framesOfType(conn, "cf_agent_use_chat_response").find(
      (f) => (f.chunk as { type: string }).type === "tool-approval-requested",
    );
    expect(approvalRequested).toBeDefined();

    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: "call_1", approved: true }));

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Handled"))).toBe(true);
    });
    const messages = await agent.getMessages();
    const toolPart = messages[1]!.parts.find((p) => p.type === "tool-dangerous");
    expect(toolPart).toMatchObject({ state: "output-available", output: { result: 10 } });
  });

  it("reject: settles the tool part as output-error and auto-continues", async () => {
    const { agent, mem } = makeApprovalAgent();
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "do it" }));

    await agent.onMessage(
      conn,
      JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: "call_1", approved: false, reason: "no" }),
    );

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Handled"))).toBe(true);
    });
    const messages = await agent.getMessages();
    const toolPart = messages[1]!.parts.find((p) => p.type === "tool-dangerous");
    expect(toolPart).toMatchObject({ state: "output-error" });
    expect((toolPart as { errorText: string }).errorText).toContain("no");
  });

  it("durable-pause: parks the execution; approveExecution writes output and auto-continues", async () => {
    const { agent, mem } = makeThink([
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
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "deploy it" }));

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
  it("broadcasts cf_agent_chat_clear and empties history", async () => {
    const { agent, mem } = makeThink([{ kind: "text", text: "hi" }]);
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "Hi" }));
    expect(await agent.getMessages()).toHaveLength(2);

    await agent.clearMessages();

    expect(framesOfType(conn, "cf_agent_chat_clear")).toHaveLength(1);
    expect(await agent.getMessages()).toHaveLength(0);
  });

  it("cancels a running turn", async () => {
    const { agent, mem } = makeThink([{ kind: "hang" }]);
    await agent.start();

    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
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
    const { agent, mem, model } = makeChannelAgent();
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(
      conn,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "hi", channel: "support" }),
    );
    expect(model.requests[0]!.system).toContain("Be terse.");
  });

  it("caps steps at the channel's maxTurns", async () => {
    const { agent, mem, model } = makeChannelAgent();
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(
      conn,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "hi", channel: "support" }),
    );
    expect(model.requests).toHaveLength(1);
  });

  it("beforeTurn's returned maxSteps overrides the channel's maxTurns", async () => {
    const { agent, mem, model } = makeChannelAgent();
    agent.beforeTurn = () => ({ maxSteps: 5 });
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(
      conn,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "hi", channel: "support" }),
    );
    expect(model.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Recovery — recovering-flag basics (deep eviction-recovery replay is left
//    to the e2e wave per the audit's stretch-goal allowance).
// ---------------------------------------------------------------------------

describe("Think — recovery basics", () => {
  it("broadcasts cf_agent_chat_recovering when a stall is detected", async () => {
    vi.useFakeTimers();
    try {
      const { agent, mem } = makeThink([{ kind: "hang" }]);
      agent.chatStreamStallTimeoutMs = 1000;
      await agent.start();
      const conn = createMemoryConnection("c1");
      mem.connections.add(conn);

      const chatPromise = agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "hi" }));
      await vi.advanceTimersByTimeAsync(1000);
      await chatPromise;

      const recovering = framesOfType(conn, "cf_agent_chat_recovering");
      expect(recovering.some((f) => f.active === true)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("chatRecovery: false skips fiber wrapping and still completes turns", async () => {
    const { agent, mem } = makeThink([{ kind: "text", text: "no recovery needed" }]);
    agent.chatRecovery = false;
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "hi" }));
    const messages = await agent.getMessages();
    expect(messages[1]!.parts.find((p) => p.type === "text")).toMatchObject({ text: "no recovery needed" });
  });
});

// ---------------------------------------------------------------------------
// Config surface basics
// ---------------------------------------------------------------------------

describe("Think — config surface", () => {
  it("getModel() throws by default", async () => {
    class DefaultThink extends Think<unknown> {}
    const mem = createMemoryHost({ agent: "DefaultThink", name: "a1" });
    const host = toHost(mem, { className: "DefaultThink", name: "a1" });
    const agent = new DefaultThink(host);
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);
    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "hi" }));
    const errorFrames = framesOfType(conn, "cf_agent_use_chat_response").filter(
      (f) => (f.chunk as { type: string }).type === "error",
    );
    expect(errorFrames.length).toBeGreaterThan(0);
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
});
