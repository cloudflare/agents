import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { MessageType, type OutgoingMessage } from "../types";

/**
 * Connects to the chat agent and returns the WebSocket
 */
export async function connectChatWS(path: string): Promise<{ ws: WebSocket }> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

/**
 * Type guard for CF_AGENT_USE_CHAT_RESPONSE messages
 */
export function isUseChatResponseMessage(
  m: unknown
): m is Extract<
  OutgoingMessage,
  { type: MessageType.CF_AGENT_USE_CHAT_RESPONSE }
> {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE
  );
}

export function waitForChatClearBroadcast(
  ws: WebSocket,
  timeoutMs = 3000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for chat clear broadcast"));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      const data = JSON.parse(event.data as string);
      if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        resolve();
      }
    }

    ws.addEventListener("message", onMessage);
  });
}

/**
 * Wait until the agent has handled `count` socket messages of `type`: the
 * socket and the RPCs that follow are separate channels, so an RPC sent
 * right after a frame can reach the agent first.
 */
export async function waitUntilHandled(
  agent: { handledMessageCountForTest(type: string): Promise<number> },
  type: string,
  count: number,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await agent.handledMessageCountForTest(type)) < count) {
    if (Date.now() > deadline) {
      throw new Error(`${type} was not handled ${count} time(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Wait until every frame the agent sent `ws` so far has reached `seen`: a
 * resume request's reply echoes its probe id, and the socket delivers in
 * order. For agents that answer a probed resume request.
 */
export async function socketBarrier(
  ws: WebSocket,
  seen: readonly unknown[],
  timeoutMs = 3000
): Promise<void> {
  const probeId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
      probeId
    })
  );
  const deadline = Date.now() + timeoutMs;
  while (
    !seen.some(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { probeId?: unknown }).probeId === probeId
    )
  ) {
    if (Date.now() > deadline) throw new Error("No reply to the barrier probe");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
