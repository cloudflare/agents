import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import { WebChannelChatTransport } from "../web/ai-sdk";
import { WebChannelClient, type WebChannelActivity } from "../web/client";
import type { TurnStatus } from "../protocol";
import type { ServerFrame } from "../web/protocol";

/** A WebSocket the test opens, feeds and inspects. */
class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeSocket.sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  receive(frame: ServerFrame): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) })
    );
  }
}

const snapshot = (conversationId: string): ServerFrame => ({
  type: "channels:snapshot",
  conversationId,
  you: { id: "alice" },
  operations: ["conversation-create"],
  messages: [],
  turns: []
});

const latest = () => FakeSocket.sockets.at(-1) as FakeSocket;

describe("WebChannelClient", () => {
  beforeEach(() => {
    FakeSocket.sockets = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists conversations, and keeps the latest list in its state", async () => {
    const client = new WebChannelClient("ws://example.com/channels/room/main");
    latest().receive(snapshot("main"));

    const listed = client.listConversations();
    const request = latest().sent.at(-1) as { requestId: string };
    expect(request).toMatchObject({ type: "channels:list-conversations" });
    const conversations = [
      { id: "main", busy: false },
      { id: "f1", parent: "main", busy: true }
    ];
    latest().receive({
      type: "channels:conversations",
      conversationId: "main",
      requestId: request.requestId,
      conversations
    });
    expect(await listed).toEqual(conversations);
    expect(client.state.conversations).toEqual(conversations);

    // A pushed list replaces it.
    latest().receive({
      type: "channels:conversations",
      conversationId: "main",
      conversations: conversations.slice(0, 1)
    });
    expect(client.state.conversations).toEqual(conversations.slice(0, 1));
    client.close();
  });

  it("follows another conversation by reconnecting to its URL", async () => {
    const client = new WebChannelClient("ws://example.com/channels/room/main");
    const first = latest();
    first.receive(snapshot("main"));
    const unacked = client.send({ type: "conversation-create" });

    client.follow("f1");
    await expect(unacked).rejects.toThrow("Switched conversation");
    expect(first.readyState).toBe(3);
    expect(latest().url).toBe("ws://example.com/channels/room/f1");
    expect(FakeSocket.sockets).toHaveLength(2);
    expect(client.state.connected).toBe(false);

    // Frames from the socket left behind are ignored.
    first.receive(snapshot("main"));
    latest().receive(snapshot("f1"));
    expect(client.state).toMatchObject({
      connected: true,
      conversationId: "f1"
    });
    client.close();
  });

  it("rejects events and list requests made after close", async () => {
    const client = new WebChannelClient("ws://example.com/channels/room/main");
    latest().receive(snapshot("main"));
    client.close();

    await expect(client.send({ type: "conversation-create" })).rejects.toThrow(
      "Closed"
    );
    await expect(client.listConversations()).rejects.toThrow("Closed");
    expect(latest().sent).toEqual([]);
  });

  describe("a reconnect waiting after a drop", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("is cancelled by follow, so the followed socket stays current", () => {
      const client = new WebChannelClient(
        "ws://example.com/channels/room/main"
      );
      latest().receive(snapshot("main"));
      latest().close();

      client.follow("f1");
      const followed = latest();
      vi.advanceTimersByTime(5000);

      expect(FakeSocket.sockets).toHaveLength(2);
      followed.receive(snapshot("f1"));
      expect(client.state).toMatchObject({
        connected: true,
        conversationId: "f1"
      });
      client.close();
    });

    it("is not scheduled when a subscriber follows during the drop", () => {
      const client = new WebChannelClient(
        "ws://example.com/channels/room/main"
      );
      latest().receive(snapshot("main"));
      const unsubscribe = client.subscribe((state) => {
        if (state.connected) return;
        unsubscribe();
        client.follow("f1");
      });
      latest().close();

      const followed = latest();
      vi.advanceTimersByTime(5000);

      expect(FakeSocket.sockets).toHaveLength(2);
      expect(followed.url).toBe("ws://example.com/channels/room/f1");
      client.close();
    });

    it("is cancelled by close", () => {
      const client = new WebChannelClient(
        "ws://example.com/channels/room/main"
      );
      latest().receive(snapshot("main"));
      latest().close();

      client.close();
      vi.advanceTimersByTime(5000);

      expect(FakeSocket.sockets).toHaveLength(1);
    });
  });

  describe("after a reconnect", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const running = (turnId: string, responseId: string): ServerFrame => ({
      type: "channels:turn",
      conversationId: "main",
      turn: { turnId, startedBy: "e1", status: "running", responseId }
    });
    const reconnect = (turns: TurnStatus[] = []) => {
      latest().close();
      vi.advanceTimersByTime(1000);
      latest().receive({ ...snapshot("main"), turns } as ServerFrame);
    };

    it("keeps reading a response that outlived its settled turn", () => {
      const client = new WebChannelClient(
        "ws://example.com/channels/room/main"
      );
      latest().receive(snapshot("main"));
      latest().receive(running("t1", "r1"));
      latest().receive({
        type: "channels:turn",
        conversationId: "main",
        turn: {
          turnId: "t1",
          startedBy: "e1",
          status: "settled",
          outcome: "completed",
          messageIds: []
        }
      });
      const activity: WebChannelActivity[] = [];
      client.onActivity((a) => activity.push(a));

      reconnect();
      expect(latest().sent).toContainEqual({
        type: "channels:subscribe",
        responseId: "r1",
        from: 0
      });
      latest().receive({
        type: "channels:end",
        conversationId: "main",
        responseId: "r1",
        state: "ended"
      });
      expect(activity).toContainEqual({
        type: "end",
        responseId: "r1",
        turnId: "t1",
        state: "ended"
      });
      client.close();
    });

    it("tells activity listeners about turns in the snapshot", () => {
      const client = new WebChannelClient(
        "ws://example.com/channels/room/main"
      );
      latest().receive(snapshot("main"));
      latest().receive(running("t1", "r1"));
      const activity: WebChannelActivity[] = [];
      client.onActivity((a) => activity.push(a));

      const restarted = {
        turnId: "t1",
        startedBy: "e1",
        status: "running" as const,
        responseId: "r2"
      };
      reconnect([restarted]);
      expect(activity).toContainEqual({ type: "turn", turn: restarted });
      client.close();
    });
  });

  describe("the AI SDK transport", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function read(stream: ReadableStream<UIMessageChunk>) {
      const chunks: UIMessageChunk[] = [];
      const reader = stream.getReader();
      const done = (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return true;
          chunks.push(next.value);
        }
      })();
      return { chunks, done };
    }

    it("follows a turn restarted under a new response while offline", async () => {
      const client = new WebChannelClient(
        "ws://example.com/channels/room/main"
      );
      latest().receive({
        ...snapshot("main"),
        turns: [
          { turnId: "t1", startedBy: "e1", status: "running", responseId: "r1" }
        ]
      } as ServerFrame);
      const transport = new WebChannelChatTransport(client);
      const stream = await transport.reconnectToStream();
      if (!stream) throw new Error("no stream");
      const { chunks, done } = await read(stream);

      latest().close();
      vi.advanceTimersByTime(1000);
      latest().receive({
        ...snapshot("main"),
        turns: [
          { turnId: "t1", startedBy: "e1", status: "running", responseId: "r2" }
        ]
      } as ServerFrame);
      latest().receive({
        type: "channels:chunks",
        conversationId: "main",
        responseId: "r2",
        from: 0,
        chunks: [{ type: "text-start", id: "x" }]
      });
      latest().receive({
        type: "channels:end",
        conversationId: "main",
        responseId: "r2",
        state: "ended"
      });
      latest().receive({
        type: "channels:turn",
        conversationId: "main",
        turn: {
          turnId: "t1",
          startedBy: "e1",
          status: "settled",
          outcome: "completed",
          messageIds: []
        }
      });
      await vi.waitFor(() => expect(chunks.at(-1)).toEqual({ type: "finish" }));
      expect(chunks).toContainEqual({ type: "text-start", id: "x" });
      expect(await done).toBe(true);
      client.close();
    });

    it("finishes when the continuation settles before answering ends", async () => {
      const client = new WebChannelClient(
        "ws://example.com/channels/room/main"
      );
      const call = {
        type: "tool",
        toolCallId: "c1",
        toolName: "where",
        owner: "alice",
        state: "input-available",
        input: null
      };
      latest().receive({
        ...snapshot("main"),
        messages: [{ id: "m1", role: "assistant", parts: [call] }],
        turns: [
          { turnId: "t1", startedBy: "e1", status: "running", responseId: "r1" }
        ]
      } as ServerFrame);
      let release = () => {};
      const transport = new WebChannelChatTransport(client, {
        tools: {
          where: () =>
            new Promise((resolve) => {
              release = () => resolve("here");
            })
        }
      });
      const stream = await transport.reconnectToStream();
      if (!stream) throw new Error("no stream");
      const { chunks, done } = await read(stream);
      const socket = latest();
      socket.receive({
        type: "channels:end",
        conversationId: "main",
        responseId: "r1",
        state: "ended"
      });
      socket.receive({
        type: "channels:turn",
        conversationId: "main",
        turn: {
          turnId: "t1",
          startedBy: "e1",
          status: "settled",
          outcome: "awaiting-input",
          messageIds: ["m1"]
        }
      });
      release();
      await vi.waitFor(() =>
        expect(socket.sent).toContainEqual(
          expect.objectContaining({ type: "channels:event" })
        )
      );
      const sent = socket.sent.at(-1) as { event: { eventId: string } };
      // The continuation runs and settles before the result's ack arrives.
      socket.receive({
        type: "channels:turn",
        conversationId: "main",
        turn: {
          turnId: "t1",
          startedBy: "e1",
          status: "settled",
          outcome: "completed",
          messageIds: ["m1"]
        }
      });
      socket.receive({
        type: "channels:ack",
        conversationId: "main",
        eventId: sent.event.eventId
      });
      await vi.waitFor(() => expect(chunks.at(-1)).toEqual({ type: "finish" }));
      expect(await done).toBe(true);
      client.close();
    });
  });
});
