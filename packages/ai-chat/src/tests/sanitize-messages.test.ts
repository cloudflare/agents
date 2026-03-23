import { env } from "cloudflare:workers";
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

  it("truncates large strings in provider-executed tool input and output", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const longContent = "x".repeat(10_000);
    const messageWithProviderTool: ChatMessage = {
      id: "msg-sanitize-provider-tool",
      role: "assistant",
      parts: [
        {
          type: "tool-code_execution",
          toolCallId: "srvtoolu_123",
          toolName: "code_execution",
          state: "output-available",
          input: {
            type: "text_editor_code_execution",
            command: "create",
            path: "/tmp/file.txt",
            file_text: longContent
          },
          providerExecuted: true,
          output: {
            type: "text_editor_code_execution_view_result",
            content: longContent,
            file_type: "text",
            num_lines: 421
          }
        },
        { type: "text", text: "Done!" }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithProviderTool]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);

    const toolPart = persisted[0].parts[0] as Record<string, unknown>;
    const input = toolPart.input as Record<string, unknown>;
    const output = toolPart.output as Record<string, unknown>;

    // Large strings should be truncated and fit within the threshold
    expect((input.file_text as string).length).toBeLessThanOrEqual(500);
    expect(input.file_text as string).toContain(
      "… [truncated, original length: 10000]"
    );

    expect((output.content as string).length).toBeLessThanOrEqual(500);
    expect(output.content as string).toContain(
      "… [truncated, original length: 10000]"
    );

    // Short fields should be preserved unchanged
    expect(input.command).toBe("create");
    expect(input.path).toBe("/tmp/file.txt");
    expect(output.file_type).toBe("text");
    expect(output.num_lines).toBe(421);

    // Text part should be preserved
    const textParts = persisted[0].parts.filter((p) => p.type === "text");
    expect(textParts.length).toBe(1);

    ws.close(1000);
  });

  it("truncation is idempotent — re-persisting does not change the message", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const longContent = "x".repeat(10_000);
    const message: ChatMessage = {
      id: "msg-sanitize-idempotent",
      role: "assistant",
      parts: [
        {
          type: "tool-code_execution",
          toolCallId: "srvtoolu_idem",
          state: "output-available",
          input: { file_text: longContent },
          providerExecuted: true,
          output: { content: longContent }
        }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([message]);
    const first = (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Re-persist the already-truncated message (simulates reload + re-save)
    await agentStub.persistMessages(first);
    const second = (await agentStub.getPersistedMessages()) as ChatMessage[];

    // The persisted content should be identical across passes
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    ws.close(1000);
  });

  it("does not truncate tool payloads when providerExecuted is absent", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const longOutput = "y".repeat(10_000);
    const messageWithUserTool: ChatMessage = {
      id: "msg-sanitize-user-tool",
      role: "assistant",
      parts: [
        {
          type: "tool-getWeather",
          toolCallId: "call_user1",
          state: "output-available",
          input: { city: "London" },
          output: longOutput
        }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithUserTool]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const toolPart = persisted[0].parts[0] as Record<string, unknown>;

    // User-defined tool output should NOT be truncated by the provider stripping
    // (it may still be compacted by _enforceRowSizeLimit at 1.8MB, but not here)
    expect(toolPart.output).toBe(longOutput);

    ws.close(1000);
  });

  it("calls user-overridable sanitizeMessageForPersistence hook", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/custom-sanitize-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.CustomSanitizeAgent, room);

    const messageWithOutput: ChatMessage = {
      id: "msg-custom-hook",
      role: "assistant",
      parts: [
        {
          type: "tool-myTool",
          toolCallId: "call_custom1",
          state: "output-available",
          input: { query: "test" },
          output: { content: "sensitive data", metadata: "keep" }
        },
        { type: "text", text: "Hello!" }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithOutput]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);

    const toolPart = persisted[0].parts[0] as Record<string, unknown>;
    const output = toolPart.output as Record<string, unknown>;

    // The custom hook should have replaced content with "[custom-redacted]"
    expect(output.content).toBe("[custom-redacted]");
    // Other output fields should be preserved
    expect(output.metadata).toBe("keep");

    // Text part should be preserved
    const textParts = persisted[0].parts.filter((p) => p.type === "text");
    expect(textParts.length).toBe(1);

    ws.close(1000);
  });

  it("user hook runs after built-in sanitization", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/custom-sanitize-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.CustomSanitizeAgent, room);

    // Message with both OpenAI metadata (built-in strips) and tool output
    // (custom hook strips). Both should apply.
    const messageWithBoth: ChatMessage = {
      id: "msg-both-hooks",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Thinking...",
          providerMetadata: {
            openai: {
              itemId: "item_should_be_stripped"
            }
          }
        },
        {
          type: "tool-myTool",
          toolCallId: "call_both1",
          state: "output-available",
          input: {},
          output: { content: "should be redacted" }
        }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([messageWithBoth]);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(1);

    // Built-in should have stripped OpenAI metadata
    const textPart = persisted[0].parts[0] as {
      providerMetadata?: Record<string, unknown>;
    };
    expect(textPart.providerMetadata).toBeUndefined();

    // Custom hook should have redacted tool output
    const toolPart = persisted[0].parts[1] as Record<string, unknown>;
    expect((toolPart.output as Record<string, unknown>).content).toBe(
      "[custom-redacted]"
    );

    ws.close(1000);
  });
});
