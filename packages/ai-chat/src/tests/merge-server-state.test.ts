import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

// Type helper for tool call parts
type TestToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

describe("Merge Incoming With Server State", () => {
  it("preserves server-side tool outputs when client sends messages without them", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Step 1: Persist a message with tool output on the server
    const toolResultPart: TestToolCallPart = {
      type: "tool-getWeather",
      toolCallId: "call_merge_1",
      state: "output-available",
      input: { city: "London" },
      output: "Rainy, 12°C"
    };

    const serverMessage: ChatMessage = {
      id: "assistant-merge-1",
      role: "assistant",
      parts: [toolResultPart] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([serverMessage]);

    // Step 2: Client sends the same message but without the tool output
    // (client only knows about input-available state)
    const clientMessage: ChatMessage = {
      id: "assistant-merge-1",
      role: "assistant",
      parts: [
        {
          type: "tool-getWeather",
          toolCallId: "call_merge_1",
          state: "input-available",
          input: { city: "London" }
        } as unknown as ChatMessage["parts"][number]
      ]
    };

    // Send via CF_AGENT_CHAT_MESSAGES (which triggers persistMessages with merge)
    const newUserMsg: ChatMessage = {
      id: "user-merge-1",
      role: "user",
      parts: [{ type: "text", text: "Follow up question" }]
    };

    await agentStub.persistMessages([clientMessage, newUserMsg]);

    // Step 3: Verify the tool output is preserved
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const assistantMsg = persisted.find((m) => m.id === "assistant-merge-1");
    expect(assistantMsg).toBeDefined();

    const toolPart = assistantMsg!.parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("Rainy, 12°C");

    ws.close(1000);
  });

  it("passes through messages unchanged when server has no tool outputs", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "user-no-merge",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    const assistantMessage: ChatMessage = {
      id: "assistant-no-merge",
      role: "assistant",
      parts: [{ type: "text", text: "Hi there!" }]
    };

    await agentStub.persistMessages([userMessage, assistantMessage]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(2);
    expect(persisted[0].id).toBe("user-no-merge");
    expect(persisted[1].id).toBe("assistant-no-merge");

    ws.close(1000);
  });
});
