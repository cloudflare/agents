import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";
import type { UIMessage as ChatMessage } from "ai";

/**
 * Tests for the waitForMcpConnections config on AIChatAgent.
 *
 * These verify that:
 * - waitForMcpConnections = true doesn't break message processing
 * - waitForMcpConnections = { timeout: N } doesn't break message processing
 * - waitForMcpConnections = false (default) doesn't break message processing
 *
 * The actual waiting logic is tested at the MCPClientManager level in
 * client-manager.test.ts. These tests verify the config plumbing in AIChatAgent.
 */
describe("waitForMcpConnections config", () => {
  async function sendChatAndWaitForDone(agentPath: string) {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${agentPath}/${room}`);

    const messages: unknown[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 5000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      messages.push(data);

      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    const chatMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [chatMessage] })
        }
      })
    );

    const done = await donePromise;
    ws.close();
    return { done, messages };
  }

  it("should process messages with waitForMcpConnections = true", async () => {
    const { done } = await sendChatAndWaitForDone("wait-mcp-true-agent");
    expect(done).toBe(true);
  });

  it("should process messages with waitForMcpConnections = { timeout: 1000 }", async () => {
    const { done } = await sendChatAndWaitForDone("wait-mcp-timeout-agent");
    expect(done).toBe(true);
  });

  it("should process messages with waitForMcpConnections = false (default)", async () => {
    const { done } = await sendChatAndWaitForDone("wait-mcp-false-agent");
    expect(done).toBe(true);
  });
});
