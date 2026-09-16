import { env, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import { routeAgentRequest } from "../..";
import type { HeartbeatSilentObject } from "../capabilities/heartbeat";
import {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_SEND,
  CAPNWEB_TRANSPORT_VALUE,
  type TransportHostPipe
} from "../../websockets/transport-protocol";
import { HEARTBEAT_PING, HEARTBEAT_PONG } from "../../websockets/heartbeat";

/**
 * The client heartbeat (#2242): a `ping` text frame is answered with
 * `pong` on every host the WebSockets capability serves, without the
 * host's `onMessage` ever seeing it. On the hibernating wire the platform
 * answers through the auto-response pair the capability registers; on
 * the Cap'n Web wire, and anywhere the platform did not answer, the
 * capability answers itself.
 */
function textReader(socket: WebSocket) {
  const frames: string[] = [];
  const waiters: Array<(frame: string) => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const waiter = waiters.shift();
    if (waiter) waiter(event.data);
    else frames.push(event.data);
  });
  return () =>
    frames.length > 0
      ? Promise.resolve(frames.shift() as string)
      : new Promise<string>((resolve) => waiters.push(resolve));
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

async function autoResponsePair(
  namespace: DurableObjectNamespace,
  name: string
): Promise<{ request: string; response: string } | null> {
  const stub = namespace.get(namespace.idFromName(name));
  return runInDurableObject(stub, (_instance, state) => {
    const pair = state.getWebSocketAutoResponse();
    return pair ? { request: pair.request, response: pair.response } : null;
  });
}

describe("heartbeat on the hibernating wire", () => {
  it("registers the ping/pong auto-response pair on a plain host and keeps ping out of onMessage", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(
      new URL(`/agents/plain-lifecycle-object/${name}`, "https://example.com")
    );
    const next = textReader(socket);
    try {
      expect(JSON.parse(await next())).toMatchObject({
        type: "cf_agent_identity"
      });
      expect(await next()).toBe(`connected:${name}`);

      expect(
        await autoResponsePair(
          env.PlainLifecycleObject as unknown as DurableObjectNamespace,
          name
        )
      ).toEqual({ request: HEARTBEAT_PING, response: HEARTBEAT_PONG });

      // The host echoes every message it sees. A pong followed directly
      // by the echo of the next frame proves onMessage never saw the ping.
      socket.send(HEARTBEAT_PING);
      socket.send("hello");
      expect(await next()).toBe(HEARTBEAT_PONG);
      expect(await next()).toBe("echo:hello");
    } finally {
      socket.close(1000, "done");
    }
  });

  it("registers the pair on an Agent host and answers ping with pong", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(
      new URL(`/agents/test-state-agent/${name}`, "https://example.com")
    );
    const next = textReader(socket);
    try {
      expect(JSON.parse(await next())).toMatchObject({
        type: "cf_agent_identity"
      });
      expect(
        await autoResponsePair(
          env.TestStateAgent as unknown as DurableObjectNamespace,
          name
        )
      ).toEqual({ request: HEARTBEAT_PING, response: HEARTBEAT_PONG });

      socket.send(HEARTBEAT_PING);
      // Skip the state push that may still be in flight after identity.
      let frame = await next();
      while (frame !== HEARTBEAT_PONG) {
        expect(() => JSON.parse(frame)).not.toThrow();
        frame = await next();
      }
      expect(frame).toBe(HEARTBEAT_PONG);
    } finally {
      socket.close(1000, "done");
    }
  });
});

describe("a host that opted out of the heartbeat", () => {
  it("registers no pair and delivers ping to onMessage like any other frame", async () => {
    const name = crypto.randomUUID();
    const socket = await upgrade(
      new URL(`/agents/heartbeat-silent-object/${name}`, "https://example.com")
    );
    const next = textReader(socket);
    try {
      expect(JSON.parse(await next())).toMatchObject({
        type: "cf_agent_identity"
      });

      const namespace =
        env.HeartbeatSilentObject as unknown as DurableObjectNamespace;
      expect(await autoResponsePair(namespace, name)).toBeNull();

      socket.send(HEARTBEAT_PING);
      const stub = namespace.get(
        namespace.idFromName(name)
      ) as DurableObjectStub<HeartbeatSilentObject>;
      await vi.waitFor(async () => {
        expect(await stub.receivedFrames()).toContain(HEARTBEAT_PING);
      });

      // Nothing was sent back: this is the silent-drop shape the client
      // heartbeat has to notice for itself.
      const answered = await Promise.race([
        next(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))
      ]);
      expect(answered).toBeNull();
    } finally {
      socket.close(1000, "done");
    }
  });
});

describe("heartbeat on the Cap'n Web wire", () => {
  it("answers ping with pong through the capability, without reaching onMessage", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    const socket = await upgrade(url);

    const frames: string[] = [];
    const waiters: Array<(frame: string) => void> = [];
    class Inbox extends RpcTarget {
      message(value: string) {
        const waiter = waiters.shift();
        if (waiter) waiter(value);
        else frames.push(value);
      }
    }
    const next = () =>
      frames.length > 0
        ? Promise.resolve(frames.shift() as string)
        : new Promise<string>((resolve) => waiters.push(resolve));
    const pipe = newWebSocketRpcSession<TransportHostPipe>(socket, new Inbox());
    try {
      expect(JSON.parse(await next())).toMatchObject({
        type: "cf_agent_identity"
      });
      expect(await next()).toBe(`connected:${name}`);

      await pipe[CAPNWEB_TRANSPORT_SEND](HEARTBEAT_PING);
      await pipe[CAPNWEB_TRANSPORT_SEND]("hello");
      expect(await next()).toBe(HEARTBEAT_PONG);
      expect(await next()).toBe("echo:hello");
    } finally {
      pipe[Symbol.dispose]();
    }
  });
});
