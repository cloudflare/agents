import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("Message Sanitization", () => {
  it("strips OpenAI itemId from persisted messages", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Persist a message with OpenAI providerMetadata containing itemId
    const messageWithItemId: ChatMessage = {
      id: "msg-sanitize-1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Hello!",
          providerMetadata: {
            openai: {
              itemId: "item_abc123",
              someOtherField: "keep-me"
            }
          }
        }
      ]
    };

    await agentStub.persistMessages([messageWithItemId]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);

    const textPart = persisted[0].parts[0] as {
      type: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    };

    // itemId should be stripped
    expect(
      (textPart.providerMetadata?.openai as Record<string, unknown>)?.itemId
    ).toBeUndefined();

    // Other OpenAI fields should be preserved
    expect(
      (textPart.providerMetadata?.openai as Record<string, unknown>)
        ?.someOtherField
    ).toBe("keep-me");

    ws.close(1000);
  });

  it("strips reasoningEncryptedContent from persisted messages", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const messageWithEncrypted: ChatMessage = {
      id: "msg-sanitize-2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Thought about it",
          providerMetadata: {
            openai: {
              itemId: "item_xyz",
              reasoningEncryptedContent: "encrypted-blob"
            }
          }
        }
      ]
    };

    await agentStub.persistMessages([messageWithEncrypted]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const textPart = persisted[0].parts[0] as {
      type: string;
      providerMetadata?: Record<string, unknown>;
    };

    // Both itemId and reasoningEncryptedContent should be stripped
    // Since no other openai fields remain, the openai key itself should be gone
    expect(textPart.providerMetadata?.openai).toBeUndefined();

    ws.close(1000);
  });

  it("removes empty reasoning parts from persisted messages", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const messageWithEmptyReasoning: ChatMessage = {
      id: "msg-sanitize-3",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "", state: "done" },
        { type: "reasoning", text: "  ", state: "done" },
        { type: "text", text: "Hello!" },
        { type: "reasoning", text: "I thought about this", state: "done" }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithEmptyReasoning]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);

    // Empty reasoning parts should be filtered out, but non-empty ones kept
    const reasoningParts = persisted[0].parts.filter(
      (p) => p.type === "reasoning"
    );
    expect(reasoningParts.length).toBe(1);
    expect((reasoningParts[0] as { text: string }).text).toBe(
      "I thought about this"
    );

    // Text part should be preserved
    const textParts = persisted[0].parts.filter((p) => p.type === "text");
    expect(textParts.length).toBe(1);

    ws.close(1000);
  });

  it("strips callProviderMetadata from tool parts", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const messageWithToolMeta: ChatMessage = {
      id: "msg-sanitize-4",
      role: "assistant",
      parts: [
        {
          type: "tool-getWeather",
          toolCallId: "call_meta1",
          state: "output-available",
          input: { city: "London" },
          output: "Sunny",
          callProviderMetadata: {
            openai: {
              itemId: "item_tool_123"
            }
          }
        }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithToolMeta]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const toolPart = persisted[0].parts[0] as Record<string, unknown>;

    // callProviderMetadata with only itemId should be completely removed
    expect(toolPart.callProviderMetadata).toBeUndefined();

    // Tool data should be preserved
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("Sunny");

    ws.close(1000);
  });

  it("preserves messages without OpenAI metadata unchanged", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const plainMessage: ChatMessage = {
      id: "msg-sanitize-5",
      role: "assistant",
      parts: [
        { type: "text", text: "Just a plain message" },
        {
          type: "text",
          text: "With non-OpenAI metadata",
          providerMetadata: {
            anthropic: { cacheControl: "ephemeral" }
          }
        }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([plainMessage]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);
    expect(persisted[0].parts.length).toBe(2);

    // Non-OpenAI metadata should be preserved
    const metaPart = persisted[0].parts[1] as {
      providerMetadata?: Record<string, unknown>;
    };
    expect(metaPart.providerMetadata?.anthropic).toEqual({
      cacheControl: "ephemeral"
    });

    ws.close(1000);
  });
});
