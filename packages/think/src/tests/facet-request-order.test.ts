import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import type { UIMessage as ChatMessage } from "ai";

/**
 * F11: chat requests a tab sends back to back, right after its socket to a
 * sub-agent opens, are answered in the order they were sent.
 */
describe("Think request order inside a facet", () => {
  it("answers requests sent right after the socket opens in send order", async () => {
    const path = `/agents/connection-state-parent/${crypto.randomUUID()}/sub/loop-test-agent/kid`;
    const response = await exports.default.fetch(`http://example.com${path}`, {
      headers: { Upgrade: "websocket" }
    });
    const ws = response.webSocket as WebSocket;
    ws.accept();
    const done: string[] = [];
    const allDone = new Promise<void>((resolve) => {
      ws.addEventListener("message", (event: MessageEvent) => {
        const data = JSON.parse(event.data as string) as {
          type?: string;
          id?: string;
          done?: boolean;
        };
        if (
          data.type === "cf_agent_use_chat_response" &&
          data.done &&
          data.id
        ) {
          done.push(data.id);
          if (done.length === 5) resolve();
        }
      });
    });
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({
        id: `u${i}`,
        role: "user",
        parts: [{ type: "text", text: `question ${i}` }]
      });
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: `req${i}`,
          init: {
            method: "POST",
            body: JSON.stringify({ messages: [...messages] })
          }
        })
      );
    }
    await allDone;
    expect(done).toEqual(["req0", "req1", "req2", "req3", "req4"]);
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close(1000);
    });
  });
});
