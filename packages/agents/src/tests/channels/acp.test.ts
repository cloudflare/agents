import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ResponseChunk, SessionEvent } from "../../experimental/channels";
import {
  WEB_IDENTITY_HEADER,
  type ServerFrame
} from "../../experimental/channels/web";

type Harness = DurableObjectStub<
  import("../capabilities/channels").ChannelsHarnessObject
>;

type Rpc = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

function harness(): Harness {
  return env.ChannelsHarnessObject.getByName(crypto.randomUUID());
}

type Client = {
  socket: WebSocket;
  /** The next JSON-RPC message from the agent. */
  next(): Promise<Rpc>;
  /** Messages already received and not yet read. */
  buffered(): Rpc[];
  send(message: Rpc): void;
  /** Send a request and read messages until its response, keeping the rest. */
  request(method: string, params?: Record<string, unknown>): Promise<Rpc>;
};

let nextId = 0;

/** Connect as the gateway would hand over an ACP upgrade. */
async function connect(stub: Harness, participant = "alice"): Promise<Client> {
  const response = await stub.fetch("https://example.com/acp", {
    headers: {
      Upgrade: "websocket",
      [WEB_IDENTITY_HEADER]: JSON.stringify({
        route: "default",
        participant: { id: participant },
        channel: "acp"
      })
    }
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  socket.accept();
  const messages: Rpc[] = [];
  const waiters: ((message: Rpc) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as Rpc;
    // The agent's own WebSockets frames share the connection.
    if (message.jsonrpc !== "2.0") return;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const client: Client = {
    socket,
    next: () =>
      messages.length > 0
        ? Promise.resolve(messages.shift() as Rpc)
        : new Promise((resolve) => waiters.push(resolve)),
    buffered: () => messages.splice(0),
    send: (message) => socket.send(JSON.stringify(message)),
    request: async (method, params) => {
      const id = ++nextId;
      client.send({ jsonrpc: "2.0", id, method, ...(params && { params }) });
      const kept: Rpc[] = [];
      for (;;) {
        const message = await client.next();
        if (message.id === id && message.method === undefined) {
          messages.unshift(...kept);
          return message;
        }
        kept.push(message);
      }
    }
  };
  return client;
}

/** Read messages until one matches, dropping the rest. */
async function until(
  client: Client,
  match: (message: Rpc) => boolean
): Promise<Rpc> {
  for (;;) {
    const message = await client.next();
    if (match(message)) return message;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const chunk = (c: ResponseChunk): SessionEvent => ({ type: "chunk", chunk: c });

/** The harness places a prompt's user message, as a real one does. */
const placed = (turnId: string, text = "hi"): SessionEvent[] => [
  {
    type: "message",
    message: { id: turnId, role: "user", parts: [{ type: "text", text }] }
  },
  { type: "operation", status: { operationId: turnId, status: "placed" } }
];

/** Open a session, then send a prompt; resolves with the prompt's turn. */
async function prompt(stub: Harness, client: Client, text = "hi") {
  const created = await client.request("session/new", {
    cwd: "/work",
    mcpServers: []
  });
  const sessionId = (created.result as { sessionId: string }).sessionId;
  const id = ++nextId;
  client.send({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] }
  });
  await settle();
  const submit = (await stub.getCalls()).find(
    (call) => call.type === "submit" && call.session === sessionId
  );
  if (submit?.type !== "submit")
    throw new Error("No prompt reached the harness");
  return { sessionId, id, turnId: submit.options?.operationId as string };
}

describe("Channels over the ACP channel", () => {
  it("answers initialize with stable ACP v1 capabilities", async () => {
    const client = await connect(harness());
    const response = await client.request("initialize", {
      protocolVersion: 2,
      clientCapabilities: {}
    });
    expect(response.result).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} }
      },
      authMethods: [],
      agentInfo: { name: "test-agent", version: "1" }
    });
    expect(
      (await client.request("session/set_mode", { sessionId: "x" })).error
    ).toEqual({ code: -32601, message: "Method not found: session/set_mode" });
  });

  it("leaves an ACP connection to the ACP channel alone", async () => {
    const stub = harness();
    const response = await stub.fetch("https://example.com/acp", {
      headers: {
        Upgrade: "websocket",
        [WEB_IDENTITY_HEADER]: JSON.stringify({
          route: "default",
          participant: { id: "alice" },
          channel: "acp"
        })
      }
    });
    const socket = response.webSocket as WebSocket;
    socket.accept();
    const frames: ServerFrame[] = [];
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data as string) as ServerFrame;
      if (frame.type?.startsWith("channels:")) frames.push(frame);
    });
    await settle();
    expect(frames).toEqual([]);
  });

  it("streams a prompt's turn, then answers with its stop reason", async () => {
    const stub = harness();
    const client = await connect(stub);
    const { sessionId, id, turnId } = await prompt(stub, client, "hello");
    expect(sessionId).toBe("s1");
    expect(await stub.getCalls()).toEqual([
      {
        type: "submit",
        session: "s1",
        input: {
          parts: [{ type: "text", text: "hello" }],
          messageId: turnId,
          from: { participantId: "alice" }
        },
        options: { operationId: turnId }
      }
    ]);

    await stub.emit(
      [
        { type: "run-start", operations: [turnId] },
        chunk({ type: "reasoning-start", id: "r" }),
        chunk({ type: "reasoning-delta", id: "r", delta: "Hmm" }),
        chunk({ type: "reasoning-end", id: "r" }),
        chunk({ type: "text-start", id: "a" }),
        chunk({ type: "text-delta", id: "a", delta: "Hi " }),
        chunk({ type: "text-delta", id: "a", delta: "there" }),
        chunk({ type: "text-end", id: "a" }),
        {
          type: "message",
          message: {
            id: "m2",
            role: "assistant",
            parts: [{ type: "text", text: "Hi there" }]
          }
        },
        {
          type: "operation",
          status: { operationId: turnId, status: "done", text: "Hi there" }
        },
        { type: "run-end", operations: [turnId] }
      ],
      sessionId
    );

    const updates: unknown[] = [];
    for (;;) {
      const message = await client.next();
      if (message.id === id) {
        expect(message.result).toEqual({ stopReason: "end_turn" });
        break;
      }
      expect(message.method).toBe("session/update");
      updates.push(message.params?.update);
    }
    expect(updates).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Hmm" }
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hi " }
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "there" }
      }
    ]);
  });

  it("answers a failed turn with an error", async () => {
    const stub = harness();
    const client = await connect(stub);
    const { sessionId, id, turnId } = await prompt(stub, client);
    await stub.emit(
      [
        {
          type: "operation",
          status: { operationId: turnId, status: "unanswered", reason: "boom" }
        }
      ],
      sessionId
    );
    expect(await until(client, (m) => m.id === id)).toMatchObject({
      error: { code: -32603, message: "Not answered: boom" }
    });
  });

  it("cancels a running turn and answers cancelled", async () => {
    const stub = harness();
    const client = await connect(stub);
    const { sessionId, id, turnId } = await prompt(stub, client);
    await stub.emit([{ type: "run-start", operations: [turnId] }], sessionId);
    client.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId }
    });
    await settle();
    expect((await stub.getCalls()).at(-1)).toEqual({
      type: "abort",
      session: sessionId,
      operationId: turnId
    });
    await stub.emit(
      [
        {
          type: "operation",
          status: {
            operationId: turnId,
            status: "unanswered",
            reason: "aborted"
          }
        },
        { type: "run-end", operations: [turnId] }
      ],
      sessionId
    );
    expect(await until(client, (m) => m.id === id)).toMatchObject({
      result: { stopReason: "cancelled" }
    });
  });

  it("asks permission for an approval and continues the turn", async () => {
    const stub = harness();
    const client = await connect(stub);
    const { sessionId, id, turnId } = await prompt(stub, client);
    const toolPart = {
      type: "tool" as const,
      toolCallId: "call1",
      toolName: "flipCoin",
      input: { times: 1 },
      approval: { id: "ap1" }
    };
    await stub.emit(
      [
        ...placed(turnId),
        { type: "run-start", operations: [turnId] },
        chunk({
          type: "tool-input-start",
          toolCallId: "call1",
          toolName: "flipCoin"
        }),
        chunk({
          type: "tool-input-available",
          toolCallId: "call1",
          toolName: "flipCoin",
          input: { times: 1 }
        }),
        chunk({
          type: "tool-approval-request",
          toolCallId: "call1",
          approvalId: "ap1"
        }),
        {
          type: "message",
          message: {
            id: "m2",
            role: "assistant",
            parts: [{ ...toolPart, state: "approval-requested" }]
          }
        },
        { type: "operation", status: { operationId: turnId, status: "done" } },
        { type: "run-end", operations: [turnId] }
      ],
      sessionId
    );

    expect((await client.next()).params?.update).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "call1",
      title: "flipCoin",
      kind: "other",
      status: "pending"
    });
    expect((await client.next()).params?.update).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call1",
      rawInput: { times: 1 }
    });
    const permission = await client.next();
    expect(permission).toMatchObject({
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "call1",
          title: "flipCoin",
          status: "pending",
          rawInput: { times: 1 }
        },
        options: [
          { optionId: "allow", kind: "allow_once" },
          { optionId: "reject", kind: "reject_once" }
        ]
      }
    });

    client.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: { outcome: { outcome: "selected", optionId: "allow" } }
    });
    await settle();
    const answer = (await stub.getCalls()).at(-1);
    expect(answer).toMatchObject({
      type: "submit",
      session: sessionId,
      input: { type: "approval", approvalId: "ap1", approved: true }
    });
    const answerOp =
      answer?.type === "submit" ? (answer.options?.operationId as string) : "";

    await stub.emit(
      [
        {
          type: "operation",
          status: { operationId: answerOp, status: "queued" }
        },
        { type: "run-start", operations: [answerOp] },
        chunk({
          type: "tool-output-available",
          toolCallId: "call1",
          output: "Heads"
        }),
        {
          type: "message",
          message: {
            id: "m2",
            role: "assistant",
            parts: [{ ...toolPart, state: "output-available", output: "Heads" }]
          }
        },
        {
          type: "operation",
          status: { operationId: answerOp, status: "done" }
        },
        { type: "run-end", operations: [answerOp] }
      ],
      sessionId
    );
    expect((await client.next()).params?.update).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call1",
      status: "completed",
      rawOutput: "Heads",
      content: [{ type: "content", content: { type: "text", text: "Heads" } }]
    });
    expect(await client.next()).toMatchObject({
      id,
      result: { stopReason: "end_turn" }
    });
  });

  it("ends the turn when the client cancels a permission", async () => {
    const stub = harness();
    const client = await connect(stub);
    const { sessionId, id, turnId } = await prompt(stub, client);
    await stub.emit(
      [
        ...placed(turnId),
        {
          type: "message",
          message: {
            id: "m2",
            role: "assistant",
            parts: [
              {
                type: "tool",
                toolCallId: "call1",
                toolName: "flipCoin",
                state: "approval-requested",
                approval: { id: "ap1" }
              }
            ]
          }
        },
        { type: "operation", status: { operationId: turnId, status: "done" } }
      ],
      sessionId
    );
    const permission = await until(
      client,
      (m) => m.method === "session/request_permission"
    );
    client.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: { outcome: { outcome: "cancelled" } }
    });
    expect(await until(client, (m) => m.id === id)).toMatchObject({
      result: { stopReason: "cancelled" }
    });
  });

  it("replays a session's transcript on load", async () => {
    const stub = harness();
    await stub.setState(
      {
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          {
            id: "a1",
            role: "assistant",
            parts: [
              { type: "text", text: "hello" },
              {
                type: "tool",
                toolCallId: "call1",
                toolName: "search",
                state: "output-error",
                input: { q: "x" },
                errorText: "offline"
              }
            ]
          }
        ],
        pending: []
      },
      "default"
    );
    const client = await connect(stub);
    expect(
      (
        await client.request("session/load", {
          sessionId: "missing",
          cwd: "/work",
          mcpServers: []
        })
      ).error
    ).toEqual({ code: -32002, message: "Session not found" });

    const id = ++nextId;
    client.send({
      jsonrpc: "2.0",
      id,
      method: "session/load",
      params: { sessionId: "default", cwd: "/work", mcpServers: [] }
    });
    const updates: unknown[] = [];
    for (;;) {
      const message = await client.next();
      if (message.id === id) {
        expect(message.result).toEqual({});
        break;
      }
      updates.push(message.params?.update);
    }
    expect(updates).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hi" },
        messageId: "u1"
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        messageId: "a1"
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "call1",
        title: "search",
        kind: "other",
        status: "failed",
        rawInput: { q: "x" },
        content: [
          { type: "content", content: { type: "text", text: "offline" } }
        ]
      }
    ]);
  });

  it("lists sessions with the directory they were opened in", async () => {
    const stub = harness();
    const client = await connect(stub);
    await client.request("session/new", { cwd: "/a", mcpServers: [] });
    await client.request("session/new", { cwd: "/b", mcpServers: [] });
    expect((await client.request("session/list", {})).result).toEqual({
      sessions: [
        { sessionId: "default", cwd: "/" },
        { sessionId: "s1", cwd: "/a" },
        { sessionId: "s2", cwd: "/b" }
      ]
    });
    expect(
      (await client.request("session/list", { cwd: "/a" })).result
    ).toEqual({
      sessions: [
        { sessionId: "default", cwd: "/a" },
        { sessionId: "s1", cwd: "/a" }
      ]
    });
  });

  it("shows a message from another surface as a user message", async () => {
    const stub = harness();
    const client = await connect(stub);
    await client.request("session/resume", {
      sessionId: "default",
      cwd: "/work"
    });
    await stub.receive(
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "yo" }]
        }
      },
      {
        route: "default",
        participant: { id: "bob" },
        surface: {
          channelKey: "slack",
          version: 1,
          address: "C1",
          label: "Slack"
        }
      }
    );
    expect(await client.next()).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "default",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "yo" },
          messageId: "m1"
        }
      }
    });
    await settle();
    expect(client.buffered()).toEqual([]);
  });

  it("rejects a prompt for a session the connection has not opened", async () => {
    const client = await connect(harness());
    expect(
      (
        await client.request("session/prompt", {
          sessionId: "default",
          prompt: [{ type: "text", text: "hi" }]
        })
      ).error
    ).toEqual({ code: -32002, message: "Session not found" });
  });
});
