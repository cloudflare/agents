import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChannelClient } from "../web/client";
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
});
