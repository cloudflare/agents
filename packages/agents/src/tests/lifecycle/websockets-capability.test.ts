import { env, RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";
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
});
