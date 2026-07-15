import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryHost, type MemoryHost } from "../memory/host.js";
import { createFakeModel, type FakeModel } from "../memory/fake-model.js";
import { createMemoryConnection, createMemoryConnectionRegistry } from "../memory/transport.js";
import type { IdSource } from "../../kernel/ids.js";
import type { ModelClient } from "../../ports/model.js";
import { action, type Action } from "../../domain/actions/actions.js";
import { callable, type StreamingResponse } from "../../domain/runtime/rpc/callable.js";
import type { ConversationEventLog } from "../../domain/events/log.js";
import type { ToolSet } from "../../domain/tools/types.js";
import type { AgentHost } from "../../app/agent.js";
import { Think } from "../../app/think.js";
import { attachChatTransport } from "./adapter.js";
import { connectChatClient } from "./test-helpers.js";

/**
 * Frame-level adapter tests (audit 25 §4): re-covers the WS protocol cases
 * R2 dropped when app/think.ts went transport-free, now exercised through
 * `attachChatTransport` + `connectChatClient` over a memory host instead of
 * Think's internals directly.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

class WsThink extends Think<{ count: number } | undefined> {
  model!: ModelClient;
  tools: ToolSet = {};
  actions: Record<string, Action> = {};
  rejectState = false;

  /**
   * No initial state by default. `getInitialState()` runs *during*
   * `super()` (Agent's constructor builds the StateContainer eagerly), i.e.
   * before any of this subclass's own field initializers have run — so a
   * plain instance field toggled after construction (as `rejectState` can
   * be, since `validateStateChange` only runs later) can't drive it. Tests
   * that need initial state subclass `WsThink` (see `makeAgent`'s
   * `initialState` option) so the override closes over the value instead.
   */
  protected override getInitialState(): { count: number } | undefined {
    return undefined;
  }

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getTools(): ToolSet {
    return this.tools;
  }

  protected override getActions(): Record<string, Action> {
    return this.actions;
  }

  protected override validateStateChange(_next: { count: number } | undefined): void {
    if (this.rejectState) throw new Error("nope");
  }

  @callable({ description: "adds two numbers" })
  add(a: number, b: number): number {
    return a + b;
  }

  @callable({ streaming: true })
  async streamCount(stream: StreamingResponse, n: number): Promise<void> {
    for (let i = 0; i < n; i++) stream.send(i);
    stream.end("done");
  }
}

function makeAgent(opts?: { workspaceTools?: boolean; initialState?: { count: number } }): {
  agent: WsThink;
  mem: MemoryHost;
} {
  const mem = createMemoryHost({ agent: "WsThink", name: "w1" });
  const host = toHost(mem, { className: "WsThink", name: "w1" });
  // Subclassed here (not toggled via an instance field) so `getInitialState`
  // closes over `opts.initialState` — see the comment on `WsThink`'s own
  // `getInitialState` above for why a post-construction field won't work.
  class Instance extends WsThink {
    protected override getInitialState(): { count: number } | undefined {
      return opts?.initialState;
    }
  }
  const agent = new Instance(host);
  agent.workspaceTools = opts?.workspaceTools ?? false;
  agent.chatToolResultDebounceMs = 0;
  mem.attachAgent(agent);
  return { agent, mem };
}

function framesOfType(frames: unknown[], type: string): Array<Record<string, unknown>> {
  return frames.filter(
    (f): f is Record<string, unknown> => typeof f === "object" && f !== null && (f as { type?: unknown }).type === type,
  );
}

function userMessage(id: string, text: string): { id: string; role: "user"; parts: Array<{ type: "text"; text: string }> } {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function chatRequest(
  id: string,
  messages: Array<{ id: string; role: "user"; parts: Array<{ type: "text"; text: string }> }>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "cf_agent_use_chat_request",
    id,
    init: { method: "POST", body: JSON.stringify({ messages, ...extras }) },
  };
}

function chunkBody(frame: Record<string, unknown>): { type: string } & Record<string, unknown> {
  if (typeof frame.body !== "string") throw new Error("response frame missing body");
  return JSON.parse(frame.body) as { type: string } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Connect sync: identity / state / history / recovering
// ---------------------------------------------------------------------------

describe("attachChatTransport — connect sync", () => {
  it("sends identity, no state frame (uninitialized), and empty chat_messages", async () => {
    const { agent } = makeAgent();
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);

    const client = await connectChatClient(transport, registry);

    expect(framesOfType(client.frames, "cf_agent_identity")).toEqual([
      { type: "cf_agent_identity", className: "WsThink", name: "w1", connectionId: client.id },
    ]);
    expect(framesOfType(client.frames, "cf_agent_state")).toEqual([]);
    expect(framesOfType(client.frames, "cf_agent_chat_messages")).toEqual([
      { type: "cf_agent_chat_messages", messages: [] },
    ]);
    expect(framesOfType(client.frames, "cf_agent_chat_recovering")).toEqual([]);
  });

  it("sends the current state frame once state is initialized", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);

    const client = await connectChatClient(transport, registry);

    expect(framesOfType(client.frames, "cf_agent_state")).toEqual([
      { type: "cf_agent_state", state: { count: 0 } },
    ]);
  });

  it("a second connection receives the same full history sync", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([{ kind: "text", text: "hi there" }]);
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);

    await agent.chat("hello", undefined, { requestId: "req_1" });

    const second = await connectChatClient(transport, registry);
    const sync = framesOfType(second.frames, "cf_agent_chat_messages")[0];
    expect(sync?.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Disconnect / close behavior
// ---------------------------------------------------------------------------

describe("attachChatTransport — disconnect", () => {
  it("a closed connection stops receiving broadcast frames", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    const framesBeforeClose = client.frames.length;
    client.close();

    agent.setState({ count: 1 });

    expect(client.frames.length).toBe(framesBeforeClose);
  });
});

// ---------------------------------------------------------------------------
// 3. shouldSendProtocolMessages suppression
// ---------------------------------------------------------------------------

describe("attachChatTransport — shouldSendProtocolMessages", () => {
  it("suppresses connect-sync and event fan-out for a muted connection only", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry, {
      shouldSendProtocolMessages: (id) => id !== "muted",
    });

    const muted = await connectChatClient(transport, registry, { connectionId: "muted" });
    expect(muted.frames).toEqual([]);

    const normal = await connectChatClient(transport, registry, { connectionId: "normal" });
    expect(normal.frames.length).toBeGreaterThan(0);

    agent.setState({ count: 5 });
    expect(muted.frames).toEqual([]);
    expect(framesOfType(normal.frames, "cf_agent_state")).toContainEqual({
      type: "cf_agent_state",
      state: { count: 5 },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. cf_agent_state: readonly rejection, validation errors, echo exclusion
// ---------------------------------------------------------------------------

describe("attachChatTransport — cf_agent_state", () => {
  it("readonly connections are rejected with cf_agent_state_error and never reach setState", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry, { readonly: (id) => id === "ro" });
    const client = await connectChatClient(transport, registry, { connectionId: "ro" });

    await client.send({ type: "cf_agent_state", state: { count: 99 } });

    expect(framesOfType(client.frames, "cf_agent_state_error")).toEqual([
      { type: "cf_agent_state_error", error: "connection is readonly" },
    ]);
    expect(agent.state).toEqual({ count: 0 });
  });

  it("a validation error is caught into cf_agent_state_error", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    agent.rejectState = true;
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send({ type: "cf_agent_state", state: { count: 1 } });

    expect(framesOfType(client.frames, "cf_agent_state_error")).toEqual([
      { type: "cf_agent_state_error", error: "nope" },
    ]);
  });

  it("a successful client state write is echoed to other connections but excluded from the originator", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const writer = await connectChatClient(transport, registry, { connectionId: "writer" });
    const other = await connectChatClient(transport, registry, { connectionId: "other" });

    await writer.send({ type: "cf_agent_state", state: { count: 7 } });

    expect(agent.state).toEqual({ count: 7 });
    expect(framesOfType(writer.frames, "cf_agent_state")).toEqual([
      { type: "cf_agent_state", state: { count: 0 } }, // only the connect-sync frame; the echo was excluded
    ]);
    expect(framesOfType(other.frames, "cf_agent_state")).toContainEqual({
      type: "cf_agent_state",
      state: { count: 7 },
    });
  });
});

// ---------------------------------------------------------------------------
// 5. rpc round-trip: plain + streaming
// ---------------------------------------------------------------------------

describe("attachChatTransport — rpc", () => {
  it("dispatches a plain callable and replies with one rpc frame", async () => {
    const { agent } = makeAgent();
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send({ type: "rpc", id: "call_1", method: "add", args: [2, 3] });

    expect(framesOfType(client.frames, "rpc")).toEqual([
      { type: "rpc", id: "call_1", success: true, result: 5, done: true },
    ]);
  });

  it("dispatches a streaming callable and replies with chunk frames then a final done frame", async () => {
    const { agent } = makeAgent();
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send({ type: "rpc", id: "call_2", method: "streamCount", args: [3] });

    const rpcFrames = framesOfType(client.frames, "rpc");
    expect(rpcFrames).toEqual([
      { type: "rpc", id: "call_2", success: true, result: 0, done: false },
      { type: "rpc", id: "call_2", success: true, result: 1, done: false },
      { type: "rpc", id: "call_2", success: true, result: 2, done: false },
      { type: "rpc", id: "call_2", success: true, result: "done", done: true },
    ]);
  });

  it("an unknown method replies with an error rpc frame", async () => {
    const { agent } = makeAgent();
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send({ type: "rpc", id: "call_3", method: "nope", args: [] });

    expect(framesOfType(client.frames, "rpc")).toEqual([
      { type: "rpc", id: "call_3", success: false, error: "not callable: nope", done: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. detach() (the transport's own "destroy"/close behavior)
// ---------------------------------------------------------------------------

describe("attachChatTransport — detach()", () => {
  it("stops all event fan-out once detached, even to still-registered connections", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);
    const before = client.frames.length;

    transport.detach();
    agent.setState({ count: 42 });

    expect(client.frames.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7. Broadcast fan-out with exclusions (chunk stream to all, state echo excluded)
// ---------------------------------------------------------------------------

describe("attachChatTransport — broadcast fan-out", () => {
  it("streams chunk frames to every connected client", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([{ kind: "text", text: "hello world" }]);
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const a = await connectChatClient(transport, registry, { connectionId: "a" });
    const b = await connectChatClient(transport, registry, { connectionId: "b" });

    await agent.chat("hi", undefined, { requestId: "req_1" });

    const aChunks = framesOfType(a.frames, "cf_agent_use_chat_response");
    const bChunks = framesOfType(b.frames, "cf_agent_use_chat_response");
    expect(aChunks.length).toBeGreaterThan(0);
    expect(aChunks).toEqual(bChunks);
  });

  it("excludes only the originating connection from a three-way state broadcast", async () => {
    const { agent } = makeAgent({ initialState: { count: 0 } });
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const a = await connectChatClient(transport, registry, { connectionId: "a" });
    const b = await connectChatClient(transport, registry, { connectionId: "b" });
    const c = await connectChatClient(transport, registry, { connectionId: "c" });

    await a.send({ type: "cf_agent_state", state: { count: 3 } });

    expect(framesOfType(a.frames, "cf_agent_state").map((f) => f.state)).toEqual([{ count: 0 }]);
    expect(framesOfType(b.frames, "cf_agent_state").map((f) => f.state)).toEqual([{ count: 0 }, { count: 3 }]);
    expect(framesOfType(c.frames, "cf_agent_state").map((f) => f.state)).toEqual([{ count: 0 }, { count: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// 8. Resume handshake: resuming / none / gap fallback
// ---------------------------------------------------------------------------

describe("attachChatTransport — resume handshake", () => {
  it("cf_agent_stream_resume_none when no turn is active", async () => {
    const { agent } = makeAgent();
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send({ type: "cf_agent_stream_resume_request" });

    expect(framesOfType(client.frames, "cf_agent_stream_resume_none")).toHaveLength(1);
    expect(framesOfType(client.frames, "cf_agent_stream_resuming")).toHaveLength(0);
  });

  it("cf_agent_stream_resuming replays the active turn's chunks with replay:true, then live", async () => {
    const { agent } = makeAgent();
    // One delta, then hang: the replay must have something after the
    // filtered-out `start` shell.
    agent.model = {
      async *stream(request) {
        yield { type: "text-delta", text: "partial " };
        await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);

    void agent.chat("go slow", undefined, { requestId: "req_hang" });
    await vi.waitFor(() => expect(agent.activeTurn()).not.toBeNull());

    const client = await connectChatClient(transport, registry);
    await client.send({ type: "cf_agent_stream_resume_request" });

    // #1645 handshake: request only announces; replay waits for the ACK.
    const resuming = framesOfType(client.frames, "cf_agent_stream_resuming");
    expect(resuming.length).toBeGreaterThan(0);
    expect(resuming.at(-1)).toMatchObject({ id: "req_hang" });
    expect(
      framesOfType(client.frames, "cf_agent_use_chat_response").filter((f) => f.replay === true),
    ).toHaveLength(0);

    await client.send({ type: "cf_agent_stream_resume_ack", id: "req_hang" });
    const replayed = framesOfType(client.frames, "cf_agent_use_chat_response").filter((f) => f.replay === true);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed[0]).toMatchObject({ id: "req_hang", done: false, replay: true });
    // Replay begins at the first delta — the `start` shell is never re-sent.
    expect(chunkBody(replayed[0]!).type).not.toBe("start");

    agent.cancelAllChats("test cleanup");
  });

  it("falls back to a full cf_agent_chat_messages resync when the catch-up read reports a gap", async () => {
    const { agent } = makeAgent();
    await agent.start();

    // A minimal double for the adapter's own gap-fallback branch: forcing a
    // *real* gap requires driving the event log's retention/gc machinery
    // (already covered at the log level by domain/events/log.test.ts), so
    // this stubs `events().read()` to report one directly and checks only
    // the adapter's reaction to it.
    const fakeLog: ConversationEventLog = {
      publish: () => {
        throw new Error("not used by this test");
      },
      head: () => 2,
      read: () => ({ kind: "gap", firstAvailable: 5 }),
      subscribe: () => () => {},
      gc: () => 0,
    };
    const gapAgent = {
      events: () => fakeLog,
      activeTurn: () => ({ requestId: "req_gap", startOffset: 0 }),
      pendingChatTerminal: () => null,
      history: async () => [{ id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }],
    } as unknown as Think;

    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(gapAgent, registry);
    const conn = createMemoryConnection("gap-conn");
    registry.add(conn);

    await transport.onMessage(conn, JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    await transport.onMessage(conn, JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "req_gap" }));

    const frames = conn.sent.map((raw) => JSON.parse(raw));
    expect(framesOfType(frames, "cf_agent_stream_resuming")).toHaveLength(1);
    expect(framesOfType(frames, "cf_agent_chat_messages")).toEqual([
      { type: "cf_agent_chat_messages", messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 9. Inbound frame parsing: use_chat_request / tool_result / tool_approval / chat_clear
// ---------------------------------------------------------------------------

describe("attachChatTransport — inbound frame parsing", () => {
  it("cf_agent_use_chat_request with `input` runs a turn end to end", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([{ kind: "text", text: "hi back" }]);
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send(chatRequest("req_a", [userMessage("u1", "hello")]));
    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages).toHaveLength(2);
    });

    const responseFrames = framesOfType(client.frames, "cf_agent_use_chat_response");
    expect(responseFrames.every((f) => f.id === "req_a")).toBe(true);
    expect(responseFrames.some((f) => f.done === true && f.body === undefined)).toBe(true);
    const streamedChunks = responseFrames.filter((f) => f.done === false).map(chunkBody);
    expect(streamedChunks[streamedChunks.length - 1]).toMatchObject({ type: "finish" });
    await vi.waitFor(() => {
      const syncs = framesOfType(client.frames, "cf_agent_chat_messages");
      expect(syncs.some((f) => Array.isArray(f.messages) && f.messages.length === 2)).toBe(true);
    });
  });

  it("cf_agent_use_chat_request with `messages` and `clientTools` offers the client tool to the model", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([{ kind: "text", text: "ok" }]);
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send({
      type: "cf_agent_use_chat_request",
      id: "req_b",
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "use the tool" }] }],
      clientTools: { pick_color: { description: "picks a color", inputSchema: { type: "object" } } },
    });
    await vi.waitFor(() => {
      expect((agent.model as unknown as { requests: Array<{ tools: Array<{ name: string }> }> }).requests).toHaveLength(1);
    });

    const toolNames = (agent.model as unknown as { requests: Array<{ tools: Array<{ name: string }> }> }).requests[0]!.tools.map(
      (t) => t.name,
    );
    expect(toolNames).toContain("pick_color");
    const modelMessages = (agent.model as FakeModel).requests[0]!.messages;
    expect(modelMessages).toContainEqual({ role: "user", content: [{ type: "text", text: "use the tool" }] });
  });

  it("cf_agent_use_chat_request with neither `input` nor `messages` is ignored", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([{ kind: "text", text: "unused" }]);
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send({ type: "cf_agent_use_chat_request", id: "req_c" });

    expect(framesOfType(client.frames, "cf_agent_use_chat_response")).toEqual([]);
    expect((agent.model as FakeModel).requests).toEqual([]);
  });

  it("cf_agent_tool_result applies the client tool's output and auto-continues", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "add", input: { a: 2, b: 3 }, id: "call_1" },
      { kind: "text", text: "Sum is 5" },
    ]);
    agent.tools = { add: { description: "adds numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) } };
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send(chatRequest("req_d", [userMessage("u1", "add 2 and 3")]));
    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages[1]?.parts.find((p) => p.type === "tool-add")).toMatchObject({ state: "input-available" });
    });

    await client.send({ type: "cf_agent_tool_result", toolCallId: "call_1", output: 5 });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Sum is 5"))).toBe(true);
    });
  });

  it("cf_agent_tool_approval (approve) executes the action and auto-continues", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "dangerous", input: { x: 5 }, id: "call_1" },
      { kind: "text", text: "Handled" },
    ]);
    agent.actions = {
      dangerous: action({
        description: "risky",
        inputSchema: z.object({ x: z.number() }),
        approval: true,
        execute: (input: { x: number }) => ({ result: input.x * 2 }),
      }),
    };
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send(chatRequest("req_e", [userMessage("u1", "do it")]));
    await vi.waitFor(() => {
      expect(
        framesOfType(client.frames, "cf_agent_use_chat_response")
          .filter((f) => f.done === false)
          .some((f) => chunkBody(f).type === "tool-approval-requested"),
      ).toBe(true);
    });

    await client.send({ type: "cf_agent_tool_approval", toolCallId: "call_1", approved: true });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Handled"))).toBe(true);
    });
    const messages = await agent.getMessages();
    expect(messages[1]?.parts.find((p) => p.type === "tool-dangerous")).toMatchObject({
      state: "output-available",
      output: { result: 10 },
    });
  });

  it("cf_agent_tool_approval (reject) settles output-error without executing", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "dangerous", input: { x: 5 }, id: "call_1" },
      { kind: "text", text: "Handled" },
    ]);
    let executed = false;
    agent.actions = {
      dangerous: action({
        description: "risky",
        inputSchema: z.object({ x: z.number() }),
        approval: true,
        execute: (input: { x: number }) => {
          executed = true;
          return { result: input.x * 2 };
        },
      }),
    };
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send(chatRequest("req_f", [userMessage("u1", "do it")]));
    await vi.waitFor(() => {
      expect(
        framesOfType(client.frames, "cf_agent_use_chat_response")
          .filter((f) => f.done === false)
          .some((f) => chunkBody(f).type === "tool-approval-requested"),
      ).toBe(true);
    });

    await client.send({ type: "cf_agent_tool_approval", toolCallId: "call_1", approved: false, reason: "no thanks" });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Handled"))).toBe(true);
    });
    const messages = await agent.getMessages();
    expect(messages[1]?.parts.find((p) => p.type === "tool-dangerous")).toMatchObject({ state: "output-error" });
    expect(executed).toBe(false);
  });

  it("cf_agent_chat_clear clears history and broadcasts cf_agent_chat_clear", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([{ kind: "text", text: "hi" }]);
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await agent.chat("hello", undefined, { requestId: "req_g" });
    expect(await agent.getMessages()).toHaveLength(2);

    await client.send({ type: "cf_agent_chat_clear" });

    expect(await agent.getMessages()).toHaveLength(0);
    expect(framesOfType(client.frames, "cf_agent_chat_clear").length).toBeGreaterThan(0);
  });

  it("tolerates malformed frames: invalid JSON and unknown types are silently ignored", async () => {
    const { agent } = makeAgent();
    await agent.start();
    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);
    const before = client.frames.length;

    const conn = registry.get(client.id);
    if (!conn) throw new Error("connection not found");
    await transport.onMessage(conn, "not json{{{");
    await client.send({ type: "totally_unknown_frame_type", whatever: 1 });
    await client.send({ nope: "no type field at all" });

    expect(client.frames.length).toBe(before);
  });
});
