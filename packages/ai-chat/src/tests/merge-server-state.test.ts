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

  it("reuses server assistant IDs for plain text messages to avoid duplicates", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant_server_1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      }
    ]);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant_client_1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "How are you?" }]
      }
    ]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(3);

    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0].id).toBe("assistant_server_1");
    expect((assistantMessages[0].parts[0] as { text: string }).text).toBe(
      "Hi there!"
    );

    ws.close(1000);
  });

  it("matches repeated assistant text messages in order", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.persistMessages([
      {
        id: "user-server-1",
        role: "user",
        parts: [{ type: "text", text: "Say hi" }]
      },
      {
        id: "assistant_server_1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      },
      {
        id: "user-server-2",
        role: "user",
        parts: [{ type: "text", text: "Say hi again" }]
      },
      {
        id: "assistant_server_2",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      }
    ]);

    await agentStub.persistMessages([
      {
        id: "user-server-1",
        role: "user",
        parts: [{ type: "text", text: "Say hi" }]
      },
      {
        id: "assistant_client_1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      },
      {
        id: "user-server-2",
        role: "user",
        parts: [{ type: "text", text: "Say hi again" }]
      },
      {
        id: "assistant_client_2",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      }
    ]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(2);
    expect(assistantMessages[0].id).toBe("assistant_server_1");
    expect(assistantMessages[1].id).toBe("assistant_server_2");

    ws.close(1000);
  });

  it("does not reconcile when assistant content differs at the same position", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant_server_1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      }
    ]);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant_client_1",
        role: "assistant",
        parts: [{ type: "text", text: "Completely different response" }]
      }
    ]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(2);
    expect(assistantMessages.map((m) => m.id)).toContain("assistant_server_1");
    expect(assistantMessages.map((m) => m.id)).toContain("assistant_client_1");

    ws.close(1000);
  });

  it("skips tool-bearing assistant messages during reconciliation without breaking cursor", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const toolPart: TestToolCallPart = {
      type: "tool-getWeather",
      toolCallId: "call_mixed_1",
      state: "output-available",
      input: { city: "London" },
      output: "Rainy, 12°C"
    };

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "What is the weather?" }]
      },
      {
        id: "assistant_server_tool",
        role: "assistant",
        parts: [toolPart] as ChatMessage["parts"]
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Thanks" }]
      },
      {
        id: "assistant_server_text",
        role: "assistant",
        parts: [{ type: "text", text: "You're welcome!" }]
      }
    ]);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "What is the weather?" }]
      },
      {
        id: "assistant_server_tool",
        role: "assistant",
        parts: [toolPart] as ChatMessage["parts"]
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Thanks" }]
      },
      {
        id: "assistant_client_text",
        role: "assistant",
        parts: [{ type: "text", text: "You're welcome!" }]
      }
    ]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    expect(persisted.length).toBe(4);

    const toolMsg = persisted.find((m) => m.id === "assistant_server_tool");
    expect(toolMsg).toBeDefined();

    const textAssistants = persisted.filter(
      (m) => m.role === "assistant" && m.id !== "assistant_server_tool"
    );
    expect(textAssistants.length).toBe(1);
    expect(textAssistants[0].id).toBe("assistant_server_text");
    expect((textAssistants[0].parts[0] as { text: string }).text).toBe(
      "You're welcome!"
    );

    ws.close(1000);
  });
});
