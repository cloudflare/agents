import { env } from "cloudflare:workers";
import {
  subscribe as subscribeDiagnostic,
  unsubscribe as unsubscribeDiagnostic
} from "node:diagnostics_channel";
import { RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";
import { CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE } from "../../websockets";
import {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_SEND,
  CAPNWEB_TRANSPORT_VALUE,
  type TransportHostPipe
} from "../../websockets/transport-protocol";

/**
 * The WebSockets capability's callables endpoint: an `RpcTarget`'s
 * methods served over a Cap'n Web session claimed from
 * `?__agents_rpc=capnweb` upgrades.
 *
 * The capability's connection-handler surface is covered by the
 * Lifecycle WebSocket suites — PlainLifecycleObject's handlers live in
 * its WebSockets capability.
 */

type PlainHostCallables = {
  add(a: number, b: number): Promise<number>;
  fail(message: string): Promise<never>;
  hostContext(): Promise<boolean>;
  greeting(): Promise<string>;
  streamNumbers(): Promise<ReadableStream<number>>;
};

type AgentCallables = {
  multiply(a: number, b: number): Promise<number>;
  add(a: number, b: number): Promise<number>;
};

async function connectCallables<Api>(path: string) {
  const url = new URL(path, "https://example.com");
  url.searchParams.set(CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE);
  const response = await routeAgentRequest(
    new Request(url, { headers: { Upgrade: "websocket" } }),
    env
  );
  expect(response).not.toBeNull();
  expect(response!.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  expect(socket).toBeDefined();
  socket.accept();
  const rpc = newWebSocketRpcSession<Api>(socket);
  return {
    rpc,
    close() {
      try {
        (rpc as Partial<Disposable>)[Symbol.dispose]?.();
      } catch {
        socket.close();
      }
    }
  };
}

describe("WebSockets capability callables", () => {
  it("serves the target's methods on a plain lifecycle host", async () => {
    const session = await connectCallables<PlainHostCallables>(
      `/agents/plain-lifecycle-object/${crypto.randomUUID()}`
    );
    try {
      await expect(session.rpc.add(2, 3)).resolves.toBe(5);
    } finally {
      session.close();
    }
  });

  it("invokes methods on the real target — private fields work", async () => {
    const session = await connectCallables<PlainHostCallables>(
      `/agents/plain-lifecycle-object/${crypto.randomUUID()}`
    );
    try {
      await expect(session.rpc.greeting()).resolves.toBe("host");
    } finally {
      session.close();
    }
  });

  it("runs methods inside the host invocation boundary", async () => {
    const session = await connectCallables<PlainHostCallables>(
      `/agents/plain-lifecycle-object/${crypto.randomUUID()}`
    );
    try {
      await expect(session.rpc.hostContext()).resolves.toBe(true);
    } finally {
      session.close();
    }
  });

  it("propagates thrown errors and emits rpc events", async () => {
    const name = crypto.randomUUID();
    const observed: Array<Record<string, unknown>> = [];
    const handler = (event: unknown) => {
      if (event === null || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      if (record.name !== name || record.source !== "websockets") return;
      observed.push(record);
    };
    // `rpc`/`rpc:error` events route to the dedicated rpc diagnostics
    // channel, same as the Agent's legacy RPC protocol events.
    subscribeDiagnostic("agents:rpc", handler);
    const session = await connectCallables<PlainHostCallables>(
      `/agents/plain-lifecycle-object/${name}`
    );
    try {
      await expect(session.rpc.add(1, 1)).resolves.toBe(2);
      await expect(session.rpc.fail("kaboom")).rejects.toThrow("kaboom");
      expect(observed).toEqual([
        expect.objectContaining({
          type: "rpc",
          payload: { method: "add", streaming: false }
        }),
        expect.objectContaining({
          type: "rpc:error",
          payload: { method: "fail", error: "kaboom" }
        })
      ]);
    } finally {
      unsubscribeDiagnostic("agents:rpc", handler);
      session.close();
    }
  });

  it("rejects names outside the target's interface", async () => {
    const session = await connectCallables<
      PlainHostCallables & { unregistered(): Promise<unknown> }
    >(`/agents/plain-lifecycle-object/${crypto.randomUUID()}`);
    try {
      await expect(session.rpc.unregistered()).rejects.toThrow();
    } finally {
      session.close();
    }
  });

  it("streams ReadableStream results to the caller", async () => {
    const session = await connectCallables<PlainHostCallables>(
      `/agents/plain-lifecycle-object/${crypto.randomUUID()}`
    );
    try {
      const stream = await session.rpc.streamNumbers();
      const reader = stream.getReader();
      const chunks: number[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      expect(chunks).toEqual([1, 2, 3]);
    } finally {
      session.close();
    }
  });

  it("serves an Agent's decorated methods over capnweb — one interface, every wire", async () => {
    const session = await connectCallables<
      AgentCallables & { notCallableMethod(): Promise<unknown> }
    >(`/agents/test-callable-agent/${crypto.randomUUID()}`);
    try {
      await expect(session.rpc.multiply(6, 7)).resolves.toBe(42);
      await expect(session.rpc.add(2, 3)).resolves.toBe(5);
      // Undecorated methods stay unreachable.
      await expect(session.rpc.notCallableMethod()).rejects.toThrow();
    } finally {
      session.close();
    }
  });

  it("serves decorated methods over capnweb without an explicit target", async () => {
    const session = await connectCallables<{
      childMethod(): Promise<string>;
      parentMethod(): Promise<string>;
      nonCallableMethod(): Promise<unknown>;
    }>(`/agents/test-child-agent/${crypto.randomUUID()}`);
    try {
      await expect(session.rpc.childMethod()).resolves.toBeDefined();
      await expect(session.rpc.parentMethod()).resolves.toBeDefined();
      await expect(session.rpc.nonCallableMethod()).rejects.toThrow();
    } finally {
      session.close();
    }
  });

  it("serves the same interface over the legacy JSON RPC wire", async () => {
    const name = crypto.randomUUID();
    const response = await routeAgentRequest(
      new Request(`https://example.com/agents/test-callable-agent/${name}`, {
        headers: { Upgrade: "websocket" }
      }),
      env
    );
    expect(response!.status).toBe(101);
    const socket = response!.webSocket as WebSocket;
    socket.accept();

    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for RPC reply")),
        5000
      );
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (frame.type === "rpc" && frame.id === "legacy-1") {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: "rpc",
        id: "legacy-1",
        method: "multiply",
        args: [6, 7]
      })
    );
    const frame = await reply;
    expect(frame.success).toBe(true);
    expect(frame.result).toBe(42);
    socket.close();
  });
});

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
});
