import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE } from "agents/websockets";

type Frame = { type: string } & Record<string, unknown>;

type RoomApi = {
  say(nick: string, text: string): Promise<{ id: number; text: string }>;
  history(): Promise<{ nick: string; text: string }[]>;
  members(): Promise<{ id: string; nick: string }[]>;
};

function roomUrl(room: string, suffix = "", nick?: string) {
  const url = new URL(`http://example.com/agents/room-object/${room}${suffix}`);
  if (nick) url.searchParams.set("nick", nick);
  return url;
}

/** A test-side socket that queues incoming frames so reads never race sends. */
class Member {
  readonly #queue: Frame[] = [];
  #waiters: ((frame: Frame) => void)[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#queue.push(frame);
    });
  }

  static async join(room: string, nick: string): Promise<Member> {
    const response = await exports.default.fetch(roomUrl(room, "", nick), {
      headers: { Upgrade: "websocket" }
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();
    return new Member(socket);
  }

  next(): Promise<Frame> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Read frames until one of the given type arrives. */
  async until(type: string): Promise<Frame> {
    for (;;) {
      const frame = await this.next();
      if (frame.type === type) return frame;
    }
  }

  send(frame: Record<string, unknown>) {
    this.socket.send(JSON.stringify(frame));
  }

  close(): Promise<void> {
    const closed = new Promise<void>((resolve) =>
      this.socket.addEventListener("close", () => resolve(), { once: true })
    );
    this.socket.close(1000, "done");
    return closed;
  }
}

describe("WebSockets capability on a plain Durable Object", () => {
  it("accepts a hibernating socket, replays history, and broadcasts", async () => {
    const room = crypto.randomUUID();
    const alice = await Member.join(room, "alice");
    expect(await alice.next()).toEqual({ type: "history", messages: [] });
    expect(await alice.next()).toMatchObject({
      type: "join",
      nick: "alice",
      members: 1
    });

    alice.send({ type: "say", text: "hello room" });
    expect(await alice.next()).toMatchObject({
      type: "message",
      message: { nick: "alice", text: "hello room" }
    });

    const bob = await Member.join(room, "bob");
    // Bob gets the durable history, then both members see bob join.
    expect(await bob.next()).toMatchObject({
      type: "history",
      messages: [{ nick: "alice", text: "hello room" }]
    });
    expect(await bob.next()).toMatchObject({ type: "join", nick: "bob" });
    expect(await alice.next()).toMatchObject({
      type: "join",
      nick: "bob",
      members: 2
    });

    bob.send({ type: "say", text: "hi alice" });
    expect(await alice.until("message")).toMatchObject({
      message: { nick: "bob", text: "hi alice" }
    });

    await bob.close();
    expect(await alice.until("leave")).toMatchObject({
      nick: "bob",
      members: 1
    });
    await alice.close();
  });

  it("keeps per-connection state set in onConnect", async () => {
    const room = crypto.randomUUID();
    const carol = await Member.join(room, "carol");
    await carol.until("join");

    carol.send({ type: "whoami" });
    const whoami = await carol.until("whoami");
    expect(whoami.state).toMatchObject({ nick: "carol" });
    expect(typeof whoami.id).toBe("string");
    await carol.close();
  });

  it("rejects malformed frames without dropping the connection", async () => {
    const room = crypto.randomUUID();
    const dave = await Member.join(room, "dave");
    await dave.until("join");

    dave.socket.send("not json");
    expect(await dave.next()).toMatchObject({ type: "error" });
    dave.send({ type: "say", text: "still here" });
    expect(await dave.until("message")).toMatchObject({
      message: { text: "still here" }
    });
    await dave.close();
  });

  it("serves members and tags over HTTP and pushes POSTs to sockets", async () => {
    const room = crypto.randomUUID();
    const erin = await Member.join(room, "erin");
    await erin.until("join");

    const members = await exports.default.fetch(roomUrl(room, "/members"));
    expect(await members.json()).toMatchObject([{ nick: "erin" }]);

    const tagged = await exports.default.fetch(
      roomUrl(room, "/members", "erin")
    );
    expect(await tagged.json<string[]>()).toHaveLength(1);
    const untagged = await exports.default.fetch(
      roomUrl(room, "/members", "nobody")
    );
    expect(await untagged.json()).toEqual([]);

    const posted = await exports.default.fetch(roomUrl(room, "/say"), {
      method: "POST",
      body: JSON.stringify({ text: "from a webhook" })
    });
    expect(posted.status).toBe(200);
    expect(await erin.until("message")).toMatchObject({
      message: { nick: "server", text: "from a webhook" }
    });
    await erin.close();
  });

  it("serves the RpcTarget over Cap'n Web callables", async () => {
    const room = crypto.randomUUID();
    const frank = await Member.join(room, "frank");
    await frank.until("join");

    const url = roomUrl(room);
    url.searchParams.set(CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE);
    const response = await exports.default.fetch(url, {
      headers: { Upgrade: "websocket" }
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();
    const rpc = newWebSocketRpcSession<RoomApi>(socket);
    try {
      const message = await rpc.say("grace", "over rpc");
      expect(message).toMatchObject({ text: "over rpc" });
      // A callable runs inside the host boundary and can reach the
      // hibernating members like a handler does.
      expect(await frank.until("message")).toMatchObject({
        message: { nick: "grace", text: "over rpc" }
      });
      expect(await rpc.history()).toMatchObject([
        { nick: "grace", text: "over rpc" }
      ]);
      expect(await rpc.members()).toMatchObject([{ nick: "frank" }]);
    } finally {
      (rpc as Partial<Disposable>)[Symbol.dispose]?.();
      await frank.close();
    }
  });
});
