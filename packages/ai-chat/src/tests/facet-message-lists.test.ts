import { describe, it, expect, vi } from "vitest";
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

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.addEventListener("close", () => resolve(), { once: true });
    ws.close(1000);
  });
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
    const lists = (frames: Array<Record<string, unknown>>) =>
      frames.filter((f) => f.type === MessageType.CF_AGENT_CHAT_MESSAGES);
    ws1.send(
      JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages })
    );
    await vi.waitFor(() => expect(lists(other).length).toBeGreaterThan(0), {
      timeout: 5000
    });
    // The same broadcast would reach the sender; give a stray echo time to land.
    await new Promise((r) => setTimeout(r, 200));
    expect(lists(other)).toContainEqual(
      expect.objectContaining({
        messages: [expect.objectContaining({ id: "facet-1" })]
      })
    );
    expect(lists(sender)).toEqual([]);

    // Wait for both closes: the root forwards each one to the facet, and a
    // forward still in flight when the file ends fails the run.
    await Promise.all([closed(ws1), closed(ws2)]);
  });
});
