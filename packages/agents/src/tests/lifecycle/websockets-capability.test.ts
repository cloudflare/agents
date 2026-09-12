import { env, RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";
import { WebSockets } from "../../websockets";
import {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_SEND,
  CAPNWEB_TRANSPORT_VALUE,
  type TransportHostPipe
} from "../../websockets/transport-protocol";

/**
 * A plain host speaks the Agent protocol on every connection: the
 * capability identifies it on connect and answers `rpc` frames against
 * `callables`, so `useAgent` / `AgentClient` need nothing from `Agent`.
 */
type Frame = Record<string, unknown>;

function frameReader(socket: WebSocket) {
  const frames: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: Frame;
    try {
      frame = JSON.parse(event.data) as Frame;
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return () =>
    frames.length > 0
      ? Promise.resolve(frames.shift() as Frame)
      : new Promise<Frame>((resolve) => waiters.push(resolve));
}

async function upgrade(url: URL): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(url, { headers: { Upgrade: "websocket" } }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return socket;
}

describe("plain host Agent protocol on the hibernating wire", () => {
  it("identifies the host, then answers rpc frames against callables", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(
      new URL(`/agents/plain-lifecycle-object/${name}`, "https://example.com")
    );
    const next = frameReader(socket);
    try {
      expect(await next()).toEqual({
        type: "cf_agent_identity",
        name,
        agent: "plain-lifecycle-object"
      });

      socket.send(
        JSON.stringify({ type: "rpc", id: "1", method: "add", args: [2, 3] })
      );
      expect(await next()).toEqual({
        type: "rpc",
        id: "1",
        success: true,
        done: true,
        result: 5
      });

      socket.send(
        JSON.stringify({
          type: "rpc",
          id: "2",
          method: "fail",
          args: ["kaboom"]
        })
      );
      expect(await next()).toEqual({
        type: "rpc",
        id: "2",
        success: false,
        error: "kaboom"
      });

      socket.send(
        JSON.stringify({ type: "rpc", id: "3", method: "nope", args: [] })
      );
      expect(await next()).toMatchObject({ id: "3", success: false });

      // A ReadableStream result streams as chunks, then a final done frame.
      socket.send(
        JSON.stringify({
          type: "rpc",
          id: "4",
          method: "streamNumbers",
          args: []
        })
      );
      expect(await next()).toMatchObject({ id: "4", done: false, result: 1 });
      expect(await next()).toMatchObject({ id: "4", done: false, result: 2 });
      expect(await next()).toMatchObject({ id: "4", done: false, result: 3 });
      expect(await next()).toMatchObject({ id: "4", done: true });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("still passes non-rpc frames to the host's onMessage", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(
      new URL(`/agents/plain-lifecycle-object/${name}`, "https://example.com")
    );
    const text = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => {
        const data = String(event.data);
        if (data.startsWith("echo:")) resolve(data);
      });
    });
    try {
      socket.send("hello");
      expect(await text).toBe("echo:hello");
    } finally {
      socket.close(1000, "done");
    }
  });
});

describe("plain host Agent protocol on the Cap'n Web wire", () => {
  it("delivers identity through the pipe and answers rpc frames", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    const socket = await upgrade(url);

    const frames: Frame[] = [];
    const waiters: Array<(frame: Frame) => void> = [];
    class Inbox extends RpcTarget {
      message(value: string) {
        const frame = JSON.parse(value) as Frame;
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      }
    }
    const next = () =>
      frames.length > 0
        ? Promise.resolve(frames.shift() as Frame)
        : new Promise<Frame>((resolve) => waiters.push(resolve));
    const pipe = newWebSocketRpcSession<TransportHostPipe>(socket, new Inbox());
    try {
      expect(await next()).toEqual({
        type: "cf_agent_identity",
        name,
        agent: "plain-lifecycle-object"
      });
      await pipe[CAPNWEB_TRANSPORT_SEND](
        JSON.stringify({ type: "rpc", id: "1", method: "add", args: [4, 5] })
      );
      expect(await next()).toMatchObject({ id: "1", success: true, result: 9 });

      // The session is a live connection on the host.
      const members =
        await env.PlainLifecycleObject.getByName(name).connectionCount();
      expect(members).toBe(1);
    } finally {
      pipe[Symbol.dispose]();
    }
  });

  it("serves callables natively on the session root: stubs, streams, errors", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    const socket = await upgrade(url);
    const frames: Frame[] = [];
    const waiters: Array<(frame: Frame) => void> = [];
    class Inbox extends RpcTarget {
      message(value: string) {
        let frame: Frame;
        try {
          frame = JSON.parse(value) as Frame;
        } catch {
          return; // the fixture's own "connected:" text frame
        }
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      }
    }
    const next = () =>
      frames.length > 0
        ? Promise.resolve(frames.shift() as Frame)
        : new Promise<Frame>((resolve) => waiters.push(resolve));
    type Root = TransportHostPipe & {
      add(a: number, b: number): Promise<number>;
      fail(message: string): Promise<never>;
      hostContext(): Promise<boolean>;
      counter(): Promise<{
        increment(by?: number): Promise<number>;
        value(): Promise<number>;
      }>;
      streamNumbers(): Promise<ReadableStream<number>>;
    };
    const root = newWebSocketRpcSession<Root>(socket, new Inbox());
    try {
      await expect(root.add(2, 3)).resolves.toBe(5);
      await expect(root.hostContext()).resolves.toBe(true);
      await expect(root.fail("kaboom")).rejects.toThrow("kaboom");

      // An RpcTarget result is a live stub: state lives on the host side.
      const counter = await root.counter();
      await expect(counter.increment()).resolves.toBe(1);
      await expect(counter.increment(5)).resolves.toBe(6);
      await expect(counter.value()).resolves.toBe(6);

      const chunks: number[] = [];
      for await (const n of await root.streamNumbers()) chunks.push(n);
      expect(chunks).toEqual([1, 2, 3]);

      // The same result cannot cross the JSON wire: the rpc frame path
      // reports an error instead of a stub.
      expect(await next()).toMatchObject({ type: "cf_agent_identity" });
      await root[CAPNWEB_TRANSPORT_SEND](
        JSON.stringify({ type: "rpc", id: "x", method: "counter", args: [] })
      );
      expect(await next()).toMatchObject({
        type: "rpc",
        id: "x",
        success: false
      });
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("rejects a callables target that shadows the frame pipe", () => {
    class Bad extends RpcTarget {
      [CAPNWEB_TRANSPORT_SEND]() {}
    }
    expect(() => new WebSockets({ callables: new Bad() })).toThrow(
      /frame pipe/
    );
  });

  it("settles a JSON-wire call whose result cannot be serialized", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(
      new URL(`/agents/plain-lifecycle-object/${name}`, "https://example.com")
    );
    const next = frameReader(socket);
    try {
      expect(await next()).toMatchObject({ type: "cf_agent_identity" });
      socket.send(
        JSON.stringify({ type: "rpc", id: "1", method: "bigint", args: [] })
      );
      expect(await next()).toMatchObject({
        id: "1",
        success: false,
        error: expect.stringContaining("not JSON-serializable")
      });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("applies the same tag limits on the Cap'n Web wire", async () => {
    const name = crypto.randomUUID();
    const base = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    base.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);

    // Ten user tags plus the id is eleven: both wires reject the upgrade
    // the same way — Lifecycle answers 101 and closes the socket with 1011.
    const closeCodeOf = async (response: Response | null) => {
      const ws = response?.webSocket;
      if (!ws) throw new Error(`expected an upgrade, got ${response?.status}`);
      ws.accept();
      return new Promise<number>((resolve) =>
        ws.addEventListener("close", (event) => resolve(event.code), {
          once: true
        })
      );
    };
    const tooMany = new URL(base);
    tooMany.searchParams.set("tags", "10");
    const plain = new URL(tooMany);
    plain.searchParams.delete(CAPNWEB_TRANSPORT_QUERY);
    for (const url of [tooMany, plain]) {
      const response = await routeAgentRequest(
        new Request(url, { headers: { Upgrade: "websocket" } }),
        env
      );
      expect(await closeCodeOf(response)).toBe(1011);
    }
    expect(
      await env.PlainLifecycleObject.getByName(name).connectionCount()
    ).toBe(0);

    const ok = new URL(base);
    ok.searchParams.set("tags", "9");
    ok.searchParams.set("_pk", "tagged-" + name);
    const socket = await upgrade(ok);
    class Inbox extends RpcTarget {
      message() {}
    }
    const root = newWebSocketRpcSession<TransportHostPipe>(socket, new Inbox());
    try {
      const tags = await env.PlainLifecycleObject.getByName(
        name
      ).connectionTags("tagged-" + name);
      expect(tags).toHaveLength(10);
      expect(tags?.[0]).toBe("tagged-" + name);
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("keeps a Cap'n Web connection tracked when close() is given an invalid code", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    url.searchParams.set("_pk", "c-" + name);
    const socket = await upgrade(url);
    class Inbox extends RpcTarget {
      message() {}
    }
    const root = newWebSocketRpcSession<TransportHostPipe>(socket, new Inbox());
    const host = env.PlainLifecycleObject.getByName(name);
    const closedEvent = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), {
        once: true
      })
    );
    try {
      // 1006 is reserved: WebSocket.close() throws, and so does ours, with
      // the connection left open and still counted.
      expect(await host.closeConnection("c-" + name, 1006, "nope")).toMatch(
        /./
      );
      expect(await host.connectionCount()).toBe(1);

      expect(await host.closeConnection("c-" + name, 4000, "bye")).toBeNull();
      expect(await closedEvent).toBe(4000);
      expect(await host.connectionCount()).toBe(0);
    } finally {
      try {
        root[Symbol.dispose]();
      } catch {
        // already closed by the host
      }
    }
  });
});

/**
 * A plain host that composes `State` with `WebSockets` gets the hook's
 * whole state surface: pushed on connect, updated from the client,
 * broadcast to everyone else, and validated by the host.
 */
describe("state sync over connections on a plain host", () => {
  const hostUrl = (name: string) =>
    new URL(`/agents/stateful-plain-object/${name}`, "https://example.com");

  it("pushes state on connect, after identity", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(hostUrl(name));
    const next = frameReader(socket);
    try {
      expect(await next()).toMatchObject({ type: "cf_agent_identity", name });
      expect(await next()).toEqual({
        type: "cf_agent_state",
        state: { count: 0 }
      });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("applies a client update and broadcasts it to the others", async () => {
    const name = crypto.randomUUID();
    const alice = await upgrade(hostUrl(name));
    const aliceNext = frameReader(alice);
    await aliceNext();
    await aliceNext();
    const bob = await upgrade(hostUrl(name));
    const bobNext = frameReader(bob);
    await bobNext();
    await bobNext();
    try {
      alice.send(
        JSON.stringify({ type: "cf_agent_state", state: { count: 7 } })
      );
      // Bob sees it; the sender is excluded since it already has the value.
      expect(await bobNext()).toEqual({
        type: "cf_agent_state",
        state: { count: 7 }
      });
      expect(await env.StatefulPlainObject.getByName(name).getCount()).toBe(7);
    } finally {
      alice.close(1000, "done");
      bob.close(1000, "done");
    }
  });

  it("answers a rejected update with cf_agent_state_error and changes nothing", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(hostUrl(name));
    const next = frameReader(socket);
    await next();
    await next();
    try {
      socket.send(
        JSON.stringify({ type: "cf_agent_state", state: { count: -1 } })
      );
      expect(await next()).toMatchObject({
        type: "cf_agent_state_error",
        error: "count must not be negative"
      });
      expect(await env.StatefulPlainObject.getByName(name).getCount()).toBe(0);
    } finally {
      socket.close(1000, "done");
    }
  });

  it("broadcasts a host-side change", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(hostUrl(name));
    const next = frameReader(socket);
    await next();
    await next();
    try {
      await env.StatefulPlainObject.getByName(name).setCount(42);
      expect(await next()).toEqual({
        type: "cf_agent_state",
        state: { count: 42 }
      });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("broadcasts to a second socket that shares the sender's _pk", async () => {
    // `_pk` is client-supplied, so two live sockets can carry one id.
    // Excluding the sender by id would starve the other socket.
    const name = crypto.randomUUID();
    const shared = `shared-${name}`;
    const url = hostUrl(name);
    url.searchParams.set("_pk", shared);
    const alice = await upgrade(url);
    const aliceNext = frameReader(alice);
    await aliceNext();
    await aliceNext();
    const bob = await upgrade(url);
    const bobNext = frameReader(bob);
    await bobNext();
    await bobNext();
    try {
      alice.send(
        JSON.stringify({ type: "cf_agent_state", state: { count: 5 } })
      );
      expect(await bobNext()).toEqual({
        type: "cf_agent_state",
        state: { count: 5 }
      });
    } finally {
      alice.close(1000, "done");
      bob.close(1000, "done");
    }
  });

  it("syncs state over the Cap'n Web transport too", async () => {
    const name = crypto.randomUUID();
    const url = hostUrl(name);
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    const socket = await upgrade(url);
    const frames: Frame[] = [];
    const waiters: Array<(frame: Frame) => void> = [];
    class Inbox extends RpcTarget {
      message(value: string) {
        let frame: Frame;
        try {
          frame = JSON.parse(value) as Frame;
        } catch {
          return;
        }
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      }
    }
    const next = () =>
      frames.length > 0
        ? Promise.resolve(frames.shift() as Frame)
        : new Promise<Frame>((resolve) => waiters.push(resolve));
    const pipe = newWebSocketRpcSession<TransportHostPipe>(socket, new Inbox());
    try {
      expect(await next()).toMatchObject({ type: "cf_agent_identity" });
      expect(await next()).toEqual({
        type: "cf_agent_state",
        state: { count: 0 }
      });
      await pipe[CAPNWEB_TRANSPORT_SEND](
        JSON.stringify({ type: "cf_agent_state", state: { count: 3 } })
      );
      expect(await env.StatefulPlainObject.getByName(name).getCount()).toBe(3);
    } finally {
      pipe[Symbol.dispose]();
    }
  });
});
