import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ResponseChunk, SessionEvent } from "../../experimental/channels";
import {
  WEB_IDENTITY_HEADER,
  type ServerFrame
} from "../../experimental/channels/web";

/** The headers the gateway sets on an upgrade it has resolved. */
function upgrade(participant: string) {
  return {
    Upgrade: "websocket",
    [WEB_IDENTITY_HEADER]: JSON.stringify({
      // No conversation: the agent's default for the route, the route itself.
      route: "default",
      participant: { id: participant }
    })
  };
}

type Harness = DurableObjectStub<
  import("../capabilities/channels").ChannelsHarnessObject
>;

function harness(): Harness {
  return env.ChannelsHarnessObject.getByName(crypto.randomUUID());
}

type Client = {
  socket: WebSocket;
  next(): Promise<ServerFrame>;
  /** Frames already received and not yet read. */
  buffered(): ServerFrame[];
  send(frame: unknown): void;
};

async function connect(stub: Harness, participant = "alice"): Promise<Client> {
  const response = await stub.fetch("https://example.com/channels", {
    headers: upgrade(participant)
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  socket.accept();
  const frames: ServerFrame[] = [];
  const waiters: ((frame: ServerFrame) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as ServerFrame;
    // The agent's own WebSockets frames share the connection.
    if (!frame.type.startsWith("channels:")) return;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  const client: Client = {
    socket,
    next: () =>
      frames.length > 0
        ? Promise.resolve(frames.shift() as ServerFrame)
        : new Promise((resolve) => waiters.push(resolve)),
    buffered: () => frames.splice(0),
    send: (frame) => socket.send(JSON.stringify(frame))
  };
  expect((await client.next()).type).toBe("channels:snapshot");
  return client;
}

function message(eventId: string, text: string) {
  return {
    type: "channels:event",
    event: {
      type: "message",
      eventId,
      message: { id: eventId, role: "user", parts: [{ type: "text", text }] }
    }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const chunk = (c: ResponseChunk): SessionEvent => ({ type: "chunk", chunk: c });

/** Alice sends a message; the harness starts a run for it. */
async function startRun(stub: Harness, alice: Client, eventId = "e1") {
  alice.send(message(eventId, "hi"));
  await until(alice, (f) => f.type === "channels:ack");
  await stub.emit([{ type: "run-start", operations: [eventId] }]);
  const running = await until(
    alice,
    (f) => f.type === "channels:turn" && f.turn.status === "running"
  );
  if (running.type !== "channels:turn" || running.turn.status !== "running") {
    throw new Error("unreachable");
  }
  return running.turn.responseId;
}

/** Read frames until one matches, dropping the rest. */
async function until(
  client: Client,
  match: (frame: ServerFrame) => boolean
): Promise<ServerFrame> {
  for (;;) {
    const frame = await client.next();
    if (match(frame)) return frame;
  }
}

describe("Channels over the Web Channel", () => {
  it("sends the snapshot with the connection's participant", async () => {
    const stub = harness();
    await stub.setState({
      messages: [{ id: "m1", role: "user", parts: [] }],
      pending: [{ operationId: "t1", status: "queued" }]
    });
    const response = await stub.fetch("https://example.com/channels", {
      headers: upgrade("alice")
    });
    const socket = response.webSocket as WebSocket;
    socket.accept();
    const frame = await new Promise<ServerFrame>((resolve) =>
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data as string) as ServerFrame;
        if (frame.type.startsWith("channels:")) resolve(frame);
      })
    );
    expect(frame).toEqual({
      type: "channels:snapshot",
      conversationId: "default",
      you: { id: "alice" },
      operations: [
        "conversation-create",
        "conversation-fork",
        "conversation-reset"
      ],
      messages: [{ id: "m1", role: "user", parts: [] }],
      turns: [{ turnId: "t1", startedBy: "t1", status: "queued" }]
    });
  });

  // T38, T43
  it("stamps the connection's identity on inbound events, then acks", async () => {
    const stub = harness();
    const alice = await connect(stub, "alice");
    alice.send({
      type: "channels:event",
      event: {
        type: "message",
        eventId: "e1",
        message: {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        },
        participant: { id: "mallory" }
      }
    });
    expect(await until(alice, (f) => f.type === "channels:ack")).toEqual({
      type: "channels:ack",
      conversationId: "default",
      eventId: "e1"
    });
    expect(await stub.getCalls()).toEqual([
      {
        type: "submit",
        session: "default",
        input: {
          parts: [{ type: "text", text: "hi" }],
          messageId: "m1",
          from: { participantId: "alice" }
        },
        options: { operationId: "e1" }
      }
    ]);

    alice.send({
      type: "channels:event",
      event: { type: "message", eventId: "e2", message: { role: "user" } }
    });
    expect(await alice.next()).toEqual({
      type: "channels:ack",
      conversationId: "default",
      eventId: "e2",
      error: "Invalid frame: message.id"
    });
  });

  it("follows the conversation the gateway names", async () => {
    const stub = harness();
    const response = await stub.fetch("https://example.com/channels", {
      headers: {
        Upgrade: "websocket",
        [WEB_IDENTITY_HEADER]: JSON.stringify({
          route: "default",
          conversationId: "other",
          participant: { id: "alice" }
        })
      }
    });
    const socket = response.webSocket as WebSocket;
    socket.accept();
    const frame = await new Promise<ServerFrame>((resolve) =>
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data as string) as ServerFrame;
        if (frame.type.startsWith("channels:")) resolve(frame);
      })
    );
    expect(frame).toMatchObject({
      type: "channels:snapshot",
      conversationId: "other"
    });
  });

  // Echo on accept; A3 (a rejected message is never shown)
  it("echoes an accepted message to other connections only", async () => {
    const stub = harness();
    const alice = await connect(stub, "alice");
    const bob = await connect(stub, "bob");

    alice.send(message("e1", "hi"));
    expect(await until(alice, (f) => f.type === "channels:ack")).toEqual({
      type: "channels:ack",
      conversationId: "default",
      eventId: "e1"
    });
    expect(await until(bob, (f) => f.type === "channels:messages")).toEqual({
      type: "channels:messages",
      conversationId: "default",
      messages: [
        { id: "e1", role: "user", parts: [{ type: "text", text: "hi" }] }
      ]
    });

    await stub.setReject(true);
    alice.send(message("e2", "no"));
    expect(await until(alice, (f) => f.type === "channels:ack")).toEqual({
      type: "channels:ack",
      conversationId: "default",
      eventId: "e2",
      error: "Event rejected"
    });
    await settle();
    expect(
      bob.buffered().filter((f) => f.type === "channels:messages")
    ).toEqual([]);
  });

  // T56
  it("delivers a repeated event to the harness once", async () => {
    const stub = harness();
    const alice = await connect(stub);
    alice.send(message("e1", "hi"));
    alice.send(message("e1", "hi"));
    await until(alice, (f) => f.type === "channels:ack");
    await until(alice, (f) => f.type === "channels:ack");
    expect(await stub.getCalls()).toHaveLength(1);
  });

  it("cancels a turn by aborting its operation", async () => {
    const stub = harness();
    const alice = await connect(stub);
    alice.send({
      type: "channels:event",
      event: { type: "cancel", eventId: "c1", turnId: "e1" }
    });
    await until(alice, (f) => f.type === "channels:ack");
    expect(await stub.getCalls()).toEqual([
      { type: "abort", session: "default", operationId: "e1" }
    ]);
  });

  // T3, T12
  it("replays a response's prefix, then follows its live tail", async () => {
    const stub = harness();
    const alice = await connect(stub);
    const responseId = await startRun(stub, alice);
    await stub.emit([
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "He" })
    ]);

    const bob = await connect(stub, "bob");
    bob.send({ type: "channels:subscribe", responseId });
    expect(await until(bob, (f) => f.type === "channels:chunks")).toEqual({
      type: "channels:chunks",
      conversationId: "default",
      responseId,
      from: 0,
      chunks: [
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: "He" }
      ]
    });
    expect(await bob.next()).toEqual({
      type: "channels:caught-up",
      conversationId: "default",
      responseId,
      cursor: 2
    });

    await stub.emit([chunk({ type: "text-delta", id: "a", delta: "y" })]);
    expect(await bob.next()).toEqual({
      type: "channels:chunks",
      conversationId: "default",
      responseId,
      from: 2,
      chunks: [{ type: "text-delta", id: "a", delta: "y" }]
    });
    await stub.emit([{ type: "run-end", operations: ["e1"] }]);
    expect(await until(bob, (f) => f.type === "channels:end")).toEqual({
      type: "channels:end",
      conversationId: "default",
      responseId,
      state: "ended"
    });
  });

  // T1, T2, T14
  it("drops chunks that break the grammar or the size limit", async () => {
    const stub = harness();
    const alice = await connect(stub);
    const responseId = await startRun(stub, alice);
    await stub.emit([
      chunk({ type: "text-delta", id: "a", delta: "x" }),
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "reasoning-start", id: "a" }),
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "x".repeat(2000) }),
      chunk({ type: "text-end", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "x" }),
      { type: "run-end", operations: ["e1"] }
    ]);
    expect(await stub.readChunks(responseId)).toEqual([
      { type: "text-start", id: "a" },
      { type: "reasoning-start", id: "a" },
      { type: "text-end", id: "a" }
    ]);
  });

  // T15, T16
  it("marks a response left streaming as interrupted when the object wakes", async () => {
    const stub = harness();
    const alice = await connect(stub);
    const responseId = await startRun(stub, alice);
    await stub.emit([chunk({ type: "text-start", id: "a" })]);

    await stub.wake();
    expect(await until(alice, (f) => f.type === "channels:end")).toEqual({
      type: "channels:end",
      conversationId: "default",
      responseId,
      state: "interrupted"
    });
    expect(await stub.responseState(responseId)).toBe("errored");
  });

  it("interrupts every Channels response on wake, past a page of other streams", async () => {
    const stub = harness();
    const alice = await connect(stub);
    const responseId = await startRun(stub, alice);
    // More newer streaming streams than one page, from another capability.
    const others = await stub.openForeignStreams(1001);

    await stub.wake();
    expect(await stub.responseState(responseId)).toBe("errored");
    // Streams Channels does not own are left alone.
    expect(await stub.responseState(others[0])).toBe("streaming");
    expect(await stub.responseState(others[1000])).toBe("streaming");
  });

  it("settles a harness-side submission with its own message id", async () => {
    const stub = harness();
    const alice = await connect(stub);
    const user = {
      id: "m1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "hi" }]
    };
    const reply = {
      id: "a1",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "hello" }]
    };
    // Submitted to the harness directly, with a message id of its own.
    await stub.emit([
      { type: "operation", status: { operationId: "op1", status: "queued" } },
      { type: "message", message: user },
      { type: "operation", status: { operationId: "op1", status: "placed" } },
      { type: "run-start", operations: ["op1"] },
      { type: "message", message: reply },
      { type: "run-end", operations: ["op1"] },
      { type: "operation", status: { operationId: "op1", status: "done" } }
    ]);
    expect(
      await until(
        alice,
        (f) => f.type === "channels:turn" && f.turn.status === "settled"
      )
    ).toEqual({
      type: "channels:turn",
      conversationId: "default",
      turn: {
        turnId: "op1",
        startedBy: "op1",
        status: "settled",
        outcome: "completed",
        messageIds: ["a1"]
      }
    });
  });

  it("settles a turn the harness could not answer as failed", async () => {
    const stub = harness();
    const alice = await connect(stub);
    await startRun(stub, alice);
    await stub.emit([
      {
        type: "operation",
        status: { operationId: "e1", status: "unanswered", reason: "boom" }
      }
    ]);
    expect(
      await until(
        alice,
        (f) => f.type === "channels:turn" && f.turn.status === "settled"
      )
    ).toEqual({
      type: "channels:turn",
      conversationId: "default",
      turn: {
        turnId: "e1",
        startedBy: "e1",
        status: "settled",
        outcome: "failed",
        messageIds: [],
        error: "Not answered: boom"
      }
    });
  });

  // T60
  it("deletes every response on reset and pushes an empty snapshot", async () => {
    const stub = harness();
    const alice = await connect(stub);
    const ended = await startRun(stub, alice, "e1");
    await stub.emit([{ type: "run-end", operations: ["e1"] }]);
    const live = await startRun(stub, alice, "e2");

    alice.send({
      type: "channels:event",
      event: { type: "conversation-reset", eventId: "r1", handoff: "note" }
    });
    await until(alice, (f) => f.type === "channels:ack");
    expect(await stub.getCalls()).toContainEqual({
      type: "reset",
      session: "default",
      handoff: "note"
    });
    await stub.emit([{ type: "reset" }]);
    expect(
      await until(alice, (f) => f.type === "channels:snapshot")
    ).toMatchObject({
      type: "channels:snapshot",
      conversationId: "default",
      messages: [],
      turns: []
    });
    expect(await stub.responseState(live)).toBeNull();
    expect(await stub.responseState(ended)).toBeNull();

    alice.send({ type: "channels:subscribe", responseId: live });
    expect(await until(alice, (f) => f.type === "channels:end")).toEqual({
      type: "channels:end",
      conversationId: "default",
      responseId: live,
      state: "not-found"
    });
  });

  it("lists conversations, and pushes the list when one is forked", async () => {
    const stub = harness();
    const alice = await connect(stub, "alice");
    const bob = await connect(stub, "bob");

    alice.send({ type: "channels:list-conversations", requestId: "r1" });
    expect(await alice.next()).toEqual({
      type: "channels:conversations",
      conversationId: "default",
      requestId: "r1",
      conversations: [{ id: "default", busy: false }]
    });

    alice.send({
      type: "channels:event",
      event: { type: "conversation-fork", eventId: "e1" }
    });
    // Alice's fork is acknowledged before she follows it, so her client
    // never resends it into the fork; everyone hears of it.
    expect(await alice.next()).toEqual({
      type: "channels:ack",
      conversationId: "s1",
      eventId: "e1"
    });
    expect((await alice.next()).type).toBe("channels:snapshot");
    const conversations = [
      { id: "default", busy: false },
      { id: "s1", parent: "default", busy: false }
    ];
    expect(await alice.next()).toEqual({
      type: "channels:conversations",
      conversationId: "s1",
      conversations
    });
    expect(await bob.next()).toEqual({
      type: "channels:conversations",
      conversationId: "default",
      conversations
    });
  });

  it("rejects a list request without a request id", async () => {
    const alice = await connect(harness());
    alice.send({ type: "channels:list-conversations" });
    expect(await alice.next()).toEqual({
      type: "channels:ack",
      conversationId: "default",
      eventId: "",
      error: "Invalid frame: requestId"
    });
  });
});
