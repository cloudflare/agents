import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

function framesOf(ws: WebSocket): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    frames.push(JSON.parse(e.data as string) as Record<string, unknown>);
  });
  return frames;
}

describe("AIChatAgent message lists inside a facet", () => {
  it("sends a tab's list update to the other tabs of a sub-agent, not back to the sender", async () => {
    const path = `/agents/test-chat-agent/${crypto.randomUUID()}/sub/test-chat-agent/${crypto.randomUUID()}`;
    const { ws: ws1 } = await connectChatWS(path);
    const { ws: ws2 } = await connectChatWS(path);
    await new Promise((r) => setTimeout(r, 50));
    const sender = framesOf(ws1);
    const other = framesOf(ws2);

    const messages: ChatMessage[] = [
      { id: "facet-1", role: "user", parts: [{ type: "text", text: "Hi" }] }
    ];
    ws1.send(
      JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages })
    );
    await new Promise((r) => setTimeout(r, 150));

    const lists = (frames: Array<Record<string, unknown>>) =>
      frames.filter((f) => f.type === MessageType.CF_AGENT_CHAT_MESSAGES);
    expect(lists(other)).toContainEqual(
      expect.objectContaining({
        messages: [expect.objectContaining({ id: "facet-1" })]
      })
    );
    expect(lists(sender)).toEqual([]);

    ws1.close();
    ws2.close(1000);
  });
});
