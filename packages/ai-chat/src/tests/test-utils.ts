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
