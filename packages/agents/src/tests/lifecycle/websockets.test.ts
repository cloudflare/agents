import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";

function requireWebSocket(response: Response): WebSocket {
  if (!response.webSocket) {
    throw new Error("Expected a WebSocket upgrade response");
  }
  return response.webSocket;
}

describe("Lifecycle hibernating WebSockets", () => {
  it("installs always-hibernating WebSocket handlers", async () => {
    const name = crypto.randomUUID();
    const response = await routeAgentRequest(
      new Request(`https://example.com/agents/plain-lifecycle-object/${name}`, {
        headers: { Upgrade: "websocket" }
      }),
      env,
      { props: { label: "routed" } }
    );
    expect(response).not.toBeNull();
    const socket = requireWebSocket(response as Response);
    socket.accept();

    const connected = await new Promise<string>((resolve) => {
      socket.addEventListener(
        "message",
        (event) => resolve(String(event.data)),
        { once: true }
      );
    });
    expect(connected).toBe(`connected:${name}`);

    socket.send("hello");
    const echoed = await new Promise<string>((resolve) => {
      socket.addEventListener(
        "message",
        (event) => resolve(String(event.data)),
        { once: true }
      );
    });
    expect(echoed).toBe("echo:hello");
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close(1000, "done");
    await closed;

    const contexts =
      await env.PlainLifecycleObject.getByName(
        name
      ).getWebSocketContextEvents();
    expect(contexts).toHaveLength(3);
    expect(contexts).toEqual([
      {
        connectionId: contexts[0]?.connectionId,
        hostName: name,
        phase: "connect",
        requestUrl: `https://example.com/agents/plain-lifecycle-object/${name}`
      },
      {
        connectionId: contexts[0]?.connectionId,
        hostName: name,
        phase: "message",
        requestUrl: null
      },
      {
        connectionId: contexts[0]?.connectionId,
        hostName: name,
        phase: "close",
        requestUrl: null
      }
    ]);
    expect(contexts[0]?.connectionId).not.toBeNull();
  });
});
