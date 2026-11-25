import { env, exports, RpcTarget } from "cloudflare:workers";
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
 * A connection closed by the host never runs another client message.
 *
 * `onConnect` runs before the upgrade response exists, so a handler that
 * authenticates there and calls `close()` has closed the socket before the
 * client can send anything. The client can still send in the moment between
 * receiving the upgrade and receiving the Close frame. Those messages must
 * not reach `onMessage`, a callable, or a state frame handler: otherwise a
 * client that `onConnect` rejected can still run code on the object.
 */

const REJECT_AFTER_MS = "25";

type Closed = { readonly code: number; readonly reason: string };

function closeOf(socket: WebSocket): Promise<Closed> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket never closed")),
      2000
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true }
    );
  });
}

function rpcFrame(method: string, id: string = crypto.randomUUID()): string {
  return JSON.stringify({ type: "rpc", id, method, args: [] });
}

function rpcReply(socket: WebSocket, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no reply to rpc ${id}`)),
      2000
    );
    socket.addEventListener("message", (event) => {
      let frame: { id?: unknown };
      try {
        frame = JSON.parse(String(event.data)) as { id?: unknown };
      } catch {
        return; // the plain host's text frames
      }
      if (frame.id !== id) return;
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

async function upgradePlainHost(url: URL): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(url, { headers: { Upgrade: "websocket" } }),
    env
  );
  const socket = response?.webSocket;
  if (!socket) throw new Error(`expected an upgrade, got ${response?.status}`);
  return socket;
}

describe("a connection closed from onConnect", () => {
  it("runs no message or callable on the hibernating wire", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set("rejectAfterMs", REJECT_AFTER_MS);
    const socket = await upgradePlainHost(url);
    const closed = closeOf(socket);
    socket.accept();
    // Sent before the client has seen the Close frame.
    socket.send(rpcFrame("bump"));
    socket.send("hello");
    socket.send(
      JSON.stringify({ type: "cf_agent_state", state: { forged: true } })
    );

    expect(await closed).toEqual({ code: 4001, reason: "Unauthorized" });
    const host = env.PlainLifecycleObject.getByName(name);
    // Let any message the runtime still delivers run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await host.bumpCount()).toBe(0);
    const phases = (await host.getWebSocketContextEvents()).map(
      (event) => event.phase
    );
    expect(phases).not.toContain("message");
    expect(phases[0]).toBe("connect");
  });

  it("runs no callable on an Agent", async () => {
    const name = crypto.randomUUID();
    const response = await exports.default.fetch(
      `http://example.com/agents/test-callable-agent/${name}?rejectAfterMs=${REJECT_AFTER_MS}`,
      { headers: { Upgrade: "websocket" } }
    );
    const socket = response.webSocket;
    if (!socket) throw new Error(`expected an upgrade, got ${response.status}`);
    const closed = closeOf(socket);
    socket.accept();
    socket.send(rpcFrame("bump"));
    socket.send(
      JSON.stringify({ type: "cf_agent_state", state: { value: 99 } })
    );

    expect(await closed).toEqual({ code: 4001, reason: "Unauthorized" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const agent = env.TestCallableAgent.getByName(name);
    expect(await agent.bumpCount()).toBe(0);
    expect(await agent.stateValue()).toBe(0);
  });

  it("runs no frame or native callable on the Cap'n Web wire", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    url.searchParams.set("rejectAfterMs", REJECT_AFTER_MS);
    const socket = await upgradePlainHost(url);
    const closed = closeOf(socket);
    socket.accept();
    class Inbox extends RpcTarget {
      message(_value: string) {}
    }
    const pipe = newWebSocketRpcSession<TransportHostPipe & { bump(): number }>(
      socket,
      new Inbox()
    );
    try {
      const calls = [
        pipe[CAPNWEB_TRANSPORT_SEND](rpcFrame("bump")),
        pipe[CAPNWEB_TRANSPORT_SEND]("hello"),
        pipe.bump()
      ].map((call) => Promise.resolve(call).catch(() => undefined));

      expect(await closed).toEqual({ code: 4001, reason: "Unauthorized" });
      await Promise.all(calls);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const host = env.PlainLifecycleObject.getByName(name);
      expect(await host.bumpCount()).toBe(0);
      const phases = (await host.getWebSocketContextEvents()).map(
        (event) => event.phase
      );
      expect(phases).not.toContain("message");
    } finally {
      pipe[Symbol.dispose]();
    }
  });

  it("runs no message after the host closes an accepted connection", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set("_pk", `c-${name}`);
    const socket = await upgradePlainHost(url);
    socket.accept();
    const host = env.PlainLifecycleObject.getByName(name);

    expect(await host.closeConnection(`c-${name}`, 4000, "logged out")).toBe(
      null
    );
    socket.send(rpcFrame("bump"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await host.bumpCount()).toBe(0);
  });

  it("still runs messages after a close() that threw", async () => {
    const name = crypto.randomUUID();
    const url = new URL(
      `/agents/plain-lifecycle-object/${name}`,
      "https://example.com"
    );
    url.searchParams.set("_pk", `c-${name}`);
    const socket = await upgradePlainHost(url);
    socket.accept();
    const host = env.PlainLifecycleObject.getByName(name);

    // 1006 is reserved: close() throws and the socket stays open.
    expect(await host.closeConnection(`c-${name}`, 1006, "nope")).toMatch(/./);
    const reply = rpcReply(socket, "after-throw");
    socket.send(rpcFrame("bump", "after-throw"));
    expect(await reply).toMatchObject({
      id: "after-throw",
      result: 1
    });
    socket.close();
  });

  it("still runs a message the client sent just before it closed", async () => {
    const name = crypto.randomUUID();
    const socket = await upgradePlainHost(
      new URL(`/agents/plain-lifecycle-object/${name}`, "https://example.com")
    );
    socket.accept();
    // The socket reads CLOSED by the time this message is delivered; it
    // was still sent on an open connection and must run.
    socket.send(rpcFrame("bump"));
    socket.close(1000, "done");
    const host = env.PlainLifecycleObject.getByName(name);
    await expect.poll(() => host.bumpCount()).toBe(1);
  });

  it("still runs messages on a connection onConnect accepted", async () => {
    const name = crypto.randomUUID();
    const socket = await upgradePlainHost(
      new URL(`/agents/plain-lifecycle-object/${name}`, "https://example.com")
    );
    socket.accept();
    const reply = rpcReply(socket, "accepted");
    socket.send(rpcFrame("bump", "accepted"));
    expect(await reply).toMatchObject({
      id: "accepted",
      result: 1
    });
    expect(await env.PlainLifecycleObject.getByName(name).bumpCount()).toBe(1);
    socket.close();
  });
});
