import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import { MessageType, type OutgoingMessage } from "../types";

/**
 * Connects to the chat agent and returns the WebSocket
 */
export async function connectChatWS(path: string): Promise<{ ws: WebSocket }> {
  const res = await SELF.fetch(`http://example.com${path}`, {
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
