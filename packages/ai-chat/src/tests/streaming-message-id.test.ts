import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

/**
 * Coverage for the streaming message-id alignment fix.
 *
 * When a provider emits a `start` chunk WITHOUT a `messageId` (the common
 * case — e.g. Workers AI), the server persists the assistant turn under its
 * own allocated id. If that id isn't also stamped onto the streamed `start`
 * chunk, the client's AI SDK builds the live-streaming assistant under a
 * different (client-generated) id, the live stream and the later
 * `CF_AGENT_CHAT_MESSAGES` broadcast can't reconcile by id, and the
 * originating tab briefly renders the turn twice before collapsing.
 *
 * The server now stamps its allocated id onto a new turn's `start` chunk so
 * the client streams under the same id it will be persisted under.
 */
describe("Streaming assistant message-id alignment", () => {
  async function runTurn(
    room: string,
    requestId: string,
    body: Record<string, unknown>
  ): Promise<{ startChunk: { messageId?: string } | undefined }> {
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const startChunks: Array<{ messageId?: string }> = [];
    const done = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      ws.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (!isUseChatResponseMessage(data)) return;
        if (typeof data.body === "string" && data.body.length > 0) {
          try {
            const chunk = JSON.parse(data.body);
            if (chunk?.type === "start") startChunks.push(chunk);
          } catch {
            // ignore non-JSON frames
          }
        }
        if (data.done === true) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
    });

    await new Promise((r) => setTimeout(r, 50));

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: `u-${requestId}`,
                role: "user",
                parts: [{ type: "text", text: "Hello" }]
              }
            ],
            ...body
          })
        }
      })
    );

    expect(await done).toBe(true);
    ws.close(1000);

    // Exactly one start chunk for a single (non-continuation) turn.
    expect(startChunks).toHaveLength(1);
    return { startChunk: startChunks[0] };
  }

  it("stamps the persisted assistant id onto a new turn's start chunk when the provider emits none", async () => {
    const room = crypto.randomUUID();
    const { startChunk } = await runTurn(room, "req-no-id", {
      sseWithoutMessageId: true
    });

    // The streamed start chunk must now carry a concrete id.
    expect(typeof startChunk?.messageId).toBe("string");
    expect(startChunk?.messageId).toBeTruthy();

    // ...and it must equal the id the server actually persisted under, so the
    // client streams and reconciles against a single message.
    const agentStub = await getAgentByName(env.TestChatAgent, room);
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(startChunk?.messageId).toBe(assistant?.id);
  });

  it("preserves a provider-supplied start.messageId (and persists under it)", async () => {
    const room = crypto.randomUUID();
    const { startChunk } = await runTurn(room, "req-with-id", {
      sseWithMessageId: true
    });

    expect(typeof startChunk?.messageId).toBe("string");
    expect(startChunk?.messageId).toMatch(/^fresh-msg-/);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant?.id).toBe(startChunk?.messageId);
  });
});
