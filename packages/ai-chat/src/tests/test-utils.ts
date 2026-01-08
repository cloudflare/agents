import { createExecutionContext, env } from "cloudflare:test";
import { expect } from "vitest";
import worker from "./worker";

/**
 * Connects to the chat agent and returns the WebSocket and execution context
 */
export async function connectChatWS(
  path: string
): Promise<{ ws: WebSocket; ctx: ExecutionContext }> {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}
