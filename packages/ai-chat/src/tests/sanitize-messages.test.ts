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

  it("preserves Anthropic redacted_thinking blocks with empty text", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const messageWithRedactedThinking: ChatMessage = {
      id: "msg-sanitize-redacted",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "",
          state: "done",
          providerMetadata: {
            anthropic: {
              redactedData: "base64-encrypted-data"
            }
          }
        },
        { type: "reasoning", text: "", state: "done" },
        { type: "text", text: "Here is my answer" },
        {
          type: "reasoning",
          text: "Visible thinking",
          state: "done"
        }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithRedactedThinking]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);

    // The Anthropic redacted_thinking part (empty text + providerMetadata.anthropic) should be preserved
    // The plain empty reasoning part should be filtered out
    // The non-empty reasoning part should be preserved
    const reasoningParts = persisted[0].parts.filter(
      (p) => p.type === "reasoning"
    );
    expect(reasoningParts.length).toBe(2);

    const redactedPart = reasoningParts[0] as {
      text: string;
      providerMetadata?: Record<string, unknown>;
    };
    expect(redactedPart.text).toBe("");
    expect(redactedPart.providerMetadata?.anthropic).toEqual({
      redactedData: "base64-encrypted-data"
    });

    expect((reasoningParts[1] as { text: string }).text).toBe(
      "Visible thinking"
    );

    // Text part should be preserved
    const textParts = persisted[0].parts.filter((p) => p.type === "text");
    expect(textParts.length).toBe(1);

    ws.close(1000);
  });

  it("removes empty OpenAI reasoning placeholders after stripping metadata", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // OpenAI returns empty reasoning parts with only ephemeral metadata.
    // After stripping OpenAI fields, these should be filtered out entirely.
    const messageWithOpenAIReasoning: ChatMessage = {
      id: "msg-sanitize-openai-reasoning",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "",
          state: "done",
          providerMetadata: {
            openai: {
              itemId: "item_reasoning_1",
              reasoningEncryptedContent: "encrypted-blob"
            }
          }
        },
        { type: "text", text: "Final answer" }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithOpenAIReasoning]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);

    // The empty reasoning part should be gone (OpenAI metadata stripped, then empty part filtered)
    const reasoningParts = persisted[0].parts.filter(
      (p) => p.type === "reasoning"
    );
    expect(reasoningParts.length).toBe(0);

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
