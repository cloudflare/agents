/**
 * Coverage for the streaming message-id alignment fix in Think.
 *
 * Think persists the assistant turn under the id its `StreamAccumulator`
 * allocates. The provider stream (`result.toUIMessageStream()`) emits a
 * `start` chunk WITHOUT a messageId, so without intervention the client's AI
 * SDK builds the live-streaming assistant under its own generated id while the
 * server persists (and re-broadcasts via the full message list) under a
 * different id. The two can't reconcile by id and the originating tab briefly
 * renders the turn twice before collapsing.
 *
 * Think now stamps its allocated assistant id onto a new turn's `start` chunk
 * (`_alignStreamStartId`), mirroring the `@cloudflare/ai-chat` fix.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

async function connectWS(room: string): Promise<WebSocket> {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-client-tools-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

/**
 * Drive a single user turn and collect every streamed `start` chunk that was
 * broadcast to the connected client.
 */
function runTurnAndCollectStartChunks(
  ws: WebSocket,
  text: string,
  timeout = 10_000
): Promise<Array<{ messageId?: string }>> {
  return new Promise((resolve, reject) => {
    const startChunks: Array<{ messageId?: string }> = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type !== MSG_CHAT_RESPONSE) return;
        if (typeof msg.body === "string" && msg.body.length > 0) {
          try {
            const chunk = JSON.parse(msg.body) as { type?: string };
            if (chunk?.type === "start") {
              startChunks.push(chunk as { messageId?: string });
            }
          } catch {
            // ignore non-JSON frames
          }
        }
        if (msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(startChunks);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);

    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: crypto.randomUUID(),
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text }]
              }
            ]
          })
        }
      })
    );
  });
}

describe("Think — streaming assistant message-id alignment", () => {
  it("stamps the persisted assistant id onto a new turn's start chunk", async () => {
    const room = crypto.randomUUID();
    const agent = await getAgentByName(env.ThinkClientToolsAgent, room);
    await agent.setTextOnlyMode(true);
    const ws = await connectWS(room);

    const startChunks = await runTurnAndCollectStartChunks(ws, "hello");

    // A single (non-continuation) turn streams exactly one start chunk.
    expect(startChunks).toHaveLength(1);
    const start = startChunks[0];

    // The provider emits no id, so Think must have stamped one.
    expect(typeof start.messageId).toBe("string");
    expect(start.messageId).toBeTruthy();

    // And it must equal the id the assistant turn was persisted under, so the
    // client streams and reconciles against a single message.
    await new Promise((r) => setTimeout(r, 200));
    const messages = (await agent.getMessages()) as UIMessage[];
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(start.messageId).toBe(assistant?.id);

    ws.close(1000);
  });
});
