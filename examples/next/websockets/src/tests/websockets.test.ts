import { exports, RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_VALUE
} from "agents/websockets";

type Frame = { type: string } & Record<string, unknown>;

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
    const member = new Member(socket);
    // The capability identifies the plain host before onConnect runs.
    expect(await member.next()).toEqual({
      type: "cf_agent_identity",
      name: room,
      agent: "room-object"
    });
    return member;
  }

  next(): Promise<Frame> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Send an rpc frame, exactly what useAgent().stub sends. */
  rpc(id: string, method: string, ...args: unknown[]) {
    this.send({ type: "rpc", id, method, args });
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

  it("answers useAgent's rpc frames against the callables target", async () => {
    const room = crypto.randomUUID();
    const grace = await Member.join(room, "grace");
    await grace.until("join");

    grace.rpc("1", "say", "grace", "via rpc frame");
    // The callable broadcast lands as a room frame, then the rpc reply.
    expect(await grace.until("message")).toMatchObject({
      message: { nick: "grace", text: "via rpc frame" }
    });
    expect(await grace.until("rpc")).toMatchObject({
      id: "1",
      success: true,
      done: true,
      result: { text: "via rpc frame" }
    });

    grace.rpc("2", "members");
    expect(await grace.until("rpc")).toMatchObject({
      id: "2",
      result: [{ nick: "grace" }]
    });

    // A ReadableStream result streams as chunks then a final done frame.
    grace.rpc("3", "countdown", 2);
    expect(await grace.until("rpc")).toMatchObject({
      id: "3",
      done: false,
      result: 2
    });
    expect(await grace.until("rpc")).toMatchObject({
      id: "3",
      done: false,
      result: 1
    });
    expect(await grace.until("rpc")).toMatchObject({
      id: "3",
      done: false,
      result: 0
    });
    expect(await grace.until("rpc")).toMatchObject({ id: "3", done: true });

    // Bounds apply to callables too.
    grace.rpc("4", "say", "grace", "");
    expect(await grace.until("rpc")).toMatchObject({ id: "4", success: false });

    // An RpcTarget result has no JSON form: the frame path reports an error.
    grace.rpc("5", "member", "grace");
    expect(await grace.until("rpc")).toMatchObject({ id: "5", success: false });
    await grace.close();
  });

  it("speaks the same protocol over the Cap'n Web transport", async () => {
    const room = crypto.randomUUID();
    const heidi = await Member.join(room, "heidi");
    await heidi.until("join");

    const url = roomUrl(room, "", "ivan");
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    const response = await exports.default.fetch(url, {
      headers: { Upgrade: "websocket" }
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();

    const frames: Frame[] = [];
    const waiters: ((frame: Frame) => void)[] = [];
    class Inbox extends RpcTarget {
      message(value: string) {
        const frame = JSON.parse(value) as Frame;
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      }
    }
    const next = () =>
      frames.length
        ? Promise.resolve(frames.shift() as Frame)
        : new Promise<Frame>((resolve) => waiters.push(resolve));
    const until = async (type: string) => {
      for (;;) {
        const frame = await next();
        if (frame.type === type) return frame;
      }
    };
    const pipe = newWebSocketRpcSession<{
      __cf_agent_send(message: string): Promise<void>;
    }>(socket, new Inbox());
    try {
      expect(await next()).toMatchObject({
        type: "cf_agent_identity",
        name: room
      });
      expect(await until("join")).toMatchObject({ nick: "ivan", members: 2 });
      // Both wires show up in getConnections(), so both see broadcasts.
      expect(await heidi.until("join")).toMatchObject({ nick: "ivan" });

      await pipe.__cf_agent_send(
        JSON.stringify({
          type: "rpc",
          id: "1",
          method: "say",
          args: ["ivan", "over the pipe"]
        })
      );
      expect(await until("rpc")).toMatchObject({ id: "1", success: true });
      expect(await heidi.until("message")).toMatchObject({
        message: { nick: "ivan", text: "over the pipe" }
      });

      await pipe.__cf_agent_send(JSON.stringify({ type: "whoami" }));
      expect(await until("whoami")).toMatchObject({ state: { nick: "ivan" } });

      // Native callables on the same session root: stubs pass by reference.
      const root = pipe as unknown as {
        say(nick: string, text: string): Promise<{ text: string }>;
        member(nick: string): Promise<{
          whisper(from: string, text: string): Promise<boolean>;
        }>;
        countdown(from: number): Promise<ReadableStream<number>>;
      };
      expect(await root.say("ivan", "native call")).toMatchObject({
        text: "native call"
      });
      expect(await heidi.until("message")).toMatchObject({
        message: { nick: "ivan", text: "native call" }
      });
      const heidiHandle = await root.member("heidi");
      expect(await heidiHandle.whisper("ivan", "psst")).toBe(true);
      expect(await heidi.until("message")).toMatchObject({
        message: { nick: "ivan (whisper)", text: "psst" }
      });
      const chunks: number[] = [];
      for await (const n of await root.countdown(2)) chunks.push(n);
      expect(chunks).toEqual([2, 1, 0]);
    } finally {
      pipe[Symbol.dispose]();
      await heidi.close();
    }
  });
});
