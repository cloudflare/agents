import { env } from "cloudflare:workers";
import {
  subscribe as subscribeDiagnostic,
  unsubscribe as unsubscribeDiagnostic
} from "node:diagnostics_channel";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";
import { CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE } from "../../websockets";

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
