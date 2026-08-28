import { exports, RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import {
  CAPNWEB_TRANSPORT_SEND,
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_VALUE
} from "../websockets/transport-protocol";
import { MessageType } from "../types";

/**
 * End-to-end coverage for the Cap'n Web Agent transport
 * (`?__agents_transport=capnweb`).
 *
 * The transport is a message pipe: every Agent protocol frame —
 * identity, state, MCP, legacy RPC — must behave exactly as it does on
 * a hibernating socket, only carried over a Cap'n Web session.
 */

type TransportApi = {
  [CAPNWEB_TRANSPORT_SEND](message: string): Promise<void>;
};

type Frame = Record<string, unknown>;

/** Local Cap'n Web target receiving server-delivered Agent frames. */
class FrameCollector extends RpcTarget {
  readonly frames: Frame[] = [];
  #waiters = new Set<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }>();

  message(value: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof value !== "string") return;
    let frame: Frame;
    try {
      frame = JSON.parse(value) as Frame;
    } catch {
      return;
    }
    this.frames.push(frame);
    for (const waiter of this.#waiters) {
      if (waiter.predicate(frame)) {
        this.#waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  }

  waitFor(
    predicate: (frame: Frame) => boolean,
    timeoutMs = 5000
  ): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.#waiters.add(waiter);
      setTimeout(() => {
        if (this.#waiters.delete(waiter)) {
          reject(
            new Error(
              `Timed out waiting for frame; saw: ${JSON.stringify(this.frames)}`
            )
          );
        }
      }, timeoutMs);
    });
  }
}

type CapnWebTestSession = {
  readonly socket: WebSocket;
  readonly events: FrameCollector;
  send(frame: Frame): Promise<void>;
  call(method: string, args: unknown[]): Promise<unknown>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
};

async function connectCapnWeb(path: string): Promise<CapnWebTestSession> {
  const url = new URL(path, "http://example.com");
  url.searchParams.set("_pk", crypto.randomUUID());
  url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
  const response = await exports.default.fetch(url, {
    headers: { Upgrade: "websocket" }
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  expect(socket).toBeDefined();
  socket.accept();

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true }
    );
  });

  const events = new FrameCollector();
  const root = newWebSocketRpcSession<TransportApi>(socket, events);

  const send = async (frame: Frame) => {
    await root[CAPNWEB_TRANSPORT_SEND](JSON.stringify(frame));
  };

  return {
    socket,
    events,
    send,
    closed,
    async call(method: string, args: unknown[]): Promise<unknown> {
      const id = crypto.randomUUID();
      const reply = events.waitFor(
        (frame) => frame.type === MessageType.RPC && frame.id === id
      );
      await send({ args, id, method, type: MessageType.RPC });
      const response = await reply;
      if (!response.success) {
        throw new Error(String(response.error));
      }
      return response.result;
    },
    close() {
      try {
        root[Symbol.dispose]();
      } catch {
        socket.close();
      }
    }
  };
}

async function connectHibernating(path: string): Promise<{
  socket: WebSocket;
  waitFor(predicate: (frame: Frame) => boolean): Promise<Frame>;
}> {
  const response = await exports.default.fetch(
    new URL(path, "http://example.com"),
    { headers: { Upgrade: "websocket" } }
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  socket.accept();
  const frames: Frame[] = [];
  const listeners = new Set<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }>();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: Frame;
    try {
      frame = JSON.parse(event.data) as Frame;
    } catch {
      return;
    }
    frames.push(frame);
    for (const listener of listeners) {
      if (listener.predicate(frame)) {
        listeners.delete(listener);
        listener.resolve(frame);
      }
    }
  });
  return {
    socket,
    waitFor(predicate) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const listener = { predicate, resolve };
        listeners.add(listener);
        setTimeout(() => {
          if (listeners.delete(listener)) {
            reject(new Error("Timed out waiting for frame"));
          }
        }, 5000);
      });
    }
  };
}

describe("Cap'n Web Agent transport", () => {
  it("delivers identity, initial state, and MCP frames on connect", async () => {
    const session = await connectCapnWeb(
      "/agents/test-callable-agent/capnweb-connect"
    );
    try {
      const identity = await session.events.waitFor(
        (frame) => frame.type === MessageType.CF_AGENT_IDENTITY
      );
      expect(identity.name).toBe("capnweb-connect");
      expect(identity.agent).toBe("test-callable-agent");

      const state = await session.events.waitFor(
        (frame) => frame.type === MessageType.CF_AGENT_STATE
      );
      expect(state.state).toEqual({ value: 0 });

      await session.events.waitFor(
        (frame) => frame.type === MessageType.CF_AGENT_MCP_SERVERS
      );
    } finally {
      session.close();
    }
  });

  it("carries legacy RPC frames unchanged over the pipe", async () => {
    const session = await connectCapnWeb(
      "/agents/test-callable-agent/capnweb-rpc"
    );
    try {
      await expect(session.call("add", [2, 3])).resolves.toBe(5);
      await expect(session.call("throwError", ["boom"])).rejects.toThrow(
        "boom"
      );
      // Undecorated methods are reported as nonexistent, exactly as on
      // the hibernating transport.
      await expect(session.call("notCallableMethod", [])).rejects.toThrow(
        /does not exist/
      );
    } finally {
      session.close();
    }
  });

  it("broadcasts state across capnweb and hibernating transports", async () => {
    const capnWeb = await connectCapnWeb(
      "/agents/test-callable-agent/capnweb-mixed"
    );
    const hibernating = await connectHibernating(
      "/agents/test-callable-agent/capnweb-mixed"
    );
    try {
      // Both transports connected to the same instance: a state update
      // sent over the Cap'n Web pipe must reach the hibernating socket
      // and vice versa.
      await capnWeb.send({
        state: { value: 42 },
        type: MessageType.CF_AGENT_STATE
      });
      const received = await hibernating.waitFor(
        (frame) =>
          frame.type === MessageType.CF_AGENT_STATE &&
          (frame.state as { value?: number })?.value === 42
      );
      expect(received.state).toEqual({ value: 42 });

      hibernating.socket.send(
        JSON.stringify({
          state: { value: 7 },
          type: MessageType.CF_AGENT_STATE
        })
      );
      await capnWeb.events.waitFor(
        (frame) =>
          frame.type === MessageType.CF_AGENT_STATE &&
          (frame.state as { value?: number })?.value === 7
      );
    } finally {
      capnWeb.close();
      hibernating.socket.close();
    }
  });

  it("exposes capnweb connections to getConnections and connection.close", async () => {
    const first = await connectCapnWeb(
      "/agents/test-callable-agent/capnweb-connections"
    );
    const second = await connectCapnWeb(
      "/agents/test-callable-agent/capnweb-connections"
    );
    // Both sessions must be registered before counting.
    await first.events.waitFor(
      (frame) => frame.type === MessageType.CF_AGENT_IDENTITY
    );
    await second.events.waitFor(
      (frame) => frame.type === MessageType.CF_AGENT_IDENTITY
    );

    const count = await first.call("closeConnectionsForTest", [3001, "bye"]);
    expect(count).toBe(2);

    const firstClose = await first.closed;
    const secondClose = await second.closed;
    expect(firstClose.code).toBe(3001);
    expect(firstClose.reason).toBe("bye");
    expect(secondClose.code).toBe(3001);

    // The closed sessions must be gone from the registry: a fresh
    // connection sees only itself.
    const third = await connectCapnWeb(
      "/agents/test-callable-agent/capnweb-connections"
    );
    try {
      await third.events.waitFor(
        (frame) => frame.type === MessageType.CF_AGENT_IDENTITY
      );
      await expect(
        third.call("closeConnectionsForTest", [1000, "cleanup"])
      ).resolves.toBe(1);
    } finally {
      third.close();
    }
  });
});
