import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type {
  ThinkTestAgent,
  ThinkSessionTestAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkProgrammaticTestAgent,
  ThinkSanitizeTestAgent
} from "./agents/think-session";
import type { ChatResponseResult, SaveMessagesResult } from "../think";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

async function freshSessionAgent(name: string) {
  return getServerByName(
    env.ThinkSessionTestAgent as unknown as DurableObjectNamespace<ThinkSessionTestAgent>,
    name
  );
}

async function freshAsyncSessionAgent(name: string) {
  return getServerByName(
    env.ThinkAsyncConfigSessionAgent as unknown as DurableObjectNamespace<ThinkAsyncConfigSessionAgent>,
    name
  );
}

async function freshProgrammaticAgent(name: string) {
  return getServerByName(
    env.ThinkProgrammaticTestAgent as unknown as DurableObjectNamespace<ThinkProgrammaticTestAgent>,
    name
  );
}

async function freshSanitizeAgent(name: string) {
  return getServerByName(
    env.ThinkSanitizeTestAgent as unknown as DurableObjectNamespace<ThinkSanitizeTestAgent>,
    name
  );
}

async function freshConfigAgent(name: string) {
  return getServerByName(
    env.ThinkConfigTestAgent as unknown as DurableObjectNamespace<ThinkConfigTestAgent>,
    name
  );
}

// ── Core chat functionality ──────────────────────────────────────

describe("Think — core", () => {
  it("should run a chat turn and persist messages", async () => {
    const agent = await freshAgent("chat-basic");
    const result = await agent.testChat("Hello!");

    expect(result.done).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);
    expect((messages[0] as { role: string }).role).toBe("user");
    expect((messages[1] as { role: string }).role).toBe("assistant");
  });

  it("should accumulate messages across multiple turns", async () => {
    const agent = await freshAgent("chat-multi");

    await agent.testChat("First message");
    await agent.testChat("Second message");

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(4);
    expect((messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
  });

  it("should clear all messages", async () => {
    const agent = await freshAgent("chat-clear");

    await agent.testChat("Hello!");
    let messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);

    await agent.clearMessages();
    messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(0);
  });

  it("should stream events via callback", async () => {
    const agent = await freshAgent("chat-stream");
    const result = await agent.testChat("Tell me something");

    expect(result.done).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);

    const eventTypes = (result.events as string[]).map((e) => {
      const parsed = JSON.parse(e) as { type: string };
      return parsed.type;
    });

    expect(eventTypes).toContain("text-delta");
  });

  it("should return empty messages before first chat", async () => {
    const agent = await freshAgent("chat-empty");

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(0);
  });

  it("should use custom response from setResponse", async () => {
    const agent = await freshAgent("chat-custom-response");

    await agent.setResponse("Custom response text");
    const result = await agent.testChat("Say something");

    expect(result.done).toBe(true);

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);
    const assistantMsg = messages[1] as {
      role: string;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    const textParts = assistantMsg.parts.filter((p) => p.type === "text");
    const fullText = textParts.map((p) => p.text ?? "").join("");
    expect(fullText).toBe("Custom response text");
  });

  it("should build assistant message with text parts", async () => {
    const agent = await freshAgent("chat-parts");
    await agent.testChat("Hello!");

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.parts.length).toBeGreaterThan(0);

    const textParts = assistantMsg.parts.filter((p) => p.type === "text");
    expect(textParts.length).toBeGreaterThan(0);
    expect(textParts[0].text).toBeTruthy();
  });
});

// ── Error handling + partial persistence ─────────────────────────

describe("Think — error handling", () => {
  it("should handle errors and return error message", async () => {
    const agent = await freshAgent("err-basic");

    const result = await agent.testChatWithError("LLM exploded");

    expect(result.done).toBe(false);
    expect(result.error).toContain("LLM exploded");
  });

  it("should persist partial assistant message on error", async () => {
    const agent = await freshAgent("err-partial");

    await agent.setResponse("This is a partial response");
    const result = await agent.testChatWithError("Mid-stream failure");

    expect(result.done).toBe(false);
    expect(result.events.length).toBeGreaterThan(0);

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.parts.length).toBeGreaterThan(0);
  });

  it("should log errors via onChatError hook", async () => {
    const agent = await freshAgent("err-hook");

    await agent.testChatWithError("Custom error for hook");

    const errorLog = await agent.getChatErrorLog();
    expect(errorLog).toHaveLength(1);
    expect(errorLog[0]).toContain("Custom error for hook");
  });

  it("should recover and continue chatting after error", async () => {
    const agent = await freshAgent("err-recover");

    const errResult = await agent.testChatWithError("Temporary failure");
    expect(errResult.done).toBe(false);

    const okResult = await agent.testChat("After error");
    expect(okResult.done).toBe(true);

    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored).toHaveLength(4);
  });
});

// ── Abort/cancel ─────────────────────────────────────────────────

describe("Think — abort", () => {
  it("should stop streaming on abort and not call onDone", async () => {
    const agent = await freshAgent("abort-basic");

    await agent.setMultiChunkResponse([
      "chunk1 ",
      "chunk2 ",
      "chunk3 ",
      "chunk4 ",
      "chunk5 "
    ]);

    const result = await agent.testChatWithAbort("Abort me", 2);

    expect(result.doneCalled).toBe(false);
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events.length).toBeLessThan(10);
  });

  it("should persist partial message on abort", async () => {
    const agent = await freshAgent("abort-persist");

    await agent.setMultiChunkResponse([
      "partial1 ",
      "partial2 ",
      "partial3 ",
      "partial4 "
    ]);

    await agent.testChatWithAbort("Abort and persist", 2);

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.parts.length).toBeGreaterThan(0);
  });

  it("should recover and chat normally after abort", async () => {
    const agent = await freshAgent("abort-recover");

    await agent.setMultiChunkResponse(["a ", "b ", "c ", "d "]);
    await agent.testChatWithAbort("Abort this", 2);

    await agent.clearMultiChunkResponse();
    const result = await agent.testChat("Normal after abort");
    expect(result.done).toBe(true);

    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored).toHaveLength(4);
  });
});

// ── Richer input (UIMessage) ─────────────────────────────────────

describe("Think — richer input", () => {
  it("should accept UIMessage as input", async () => {
    const agent = await freshAgent("rich-uimsg");

    const userMsg: UIMessage = {
      id: "custom-id-123",
      role: "user",
      parts: [{ type: "text", text: "Hello via UIMessage" }]
    };

    const result = await agent.testChatWithUIMessage(userMsg);
    expect(result.done).toBe(true);

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const firstMsg = history[0] as { id: string; role: string };
    expect(firstMsg.id).toBe("custom-id-123");
    expect(firstMsg.role).toBe("user");
  });

  it("should handle UIMessage with multiple parts", async () => {
    const agent = await freshAgent("rich-multipart");

    const userMsg: UIMessage = {
      id: "multipart-1",
      role: "user",
      parts: [
        { type: "text", text: "First part" },
        { type: "text", text: "Second part" }
      ]
    };

    const result = await agent.testChatWithUIMessage(userMsg);
    expect(result.done).toBe(true);

    const history = await agent.getStoredMessages();
    const firstMsg = history[0] as {
      parts: Array<{ type: string; text?: string }>;
    };
    expect(firstMsg.parts).toHaveLength(2);
  });
});

// ── Session integration ──────────────────────────────────────────

describe("Think — Session integration", () => {
  it("should use tree-structured messages via Session", async () => {
    const agent = await freshAgent("session-tree");

    await agent.testChat("First");
    await agent.testChat("Second");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
  });

  it("should idempotently handle duplicate user messages", async () => {
    const agent = await freshAgent("session-idempotent");

    const msg: UIMessage = {
      id: "dup-msg-1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    await agent.testChatWithUIMessage(msg);

    // Second chat with the same message ID should not duplicate
    const result = await agent.testChat("Follow up");
    expect(result.done).toBe(true);

    const messages = await agent.getStoredMessages();
    // Should have: dup-msg-1 (user) + assistant + user + assistant = 4
    expect(messages).toHaveLength(4);
  });

  it("should clear messages via Session", async () => {
    const agent = await freshAgent("session-clear");

    await agent.testChat("Hello!");
    expect(((await agent.getStoredMessages()) as UIMessage[]).length).toBe(2);

    await agent.clearMessages();
    expect(((await agent.getStoredMessages()) as UIMessage[]).length).toBe(0);

    // Should be able to chat after clear
    const result = await agent.testChat("After clear");
    expect(result.done).toBe(true);
    expect(((await agent.getStoredMessages()) as UIMessage[]).length).toBe(2);
  });
});

// ── Context blocks ───────────────────────────────────────────────

describe("Think — context blocks", () => {
  it("should configure session with context blocks", async () => {
    const agent = await freshSessionAgent("ctx-basic");

    await agent.testChat("Hello!");

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);
  });

  it("should freeze system prompt from context blocks", async () => {
    const agent = await freshSessionAgent("ctx-prompt");

    // Write some content to the memory block
    await agent.setContextBlock("memory", "User prefers TypeScript.");

    const prompt = await agent.getSystemPromptSnapshot();

    // Prompt should contain the block content
    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("User prefers TypeScript.");
  });

  it("should persist context block content across turns", async () => {
    const agent = await freshSessionAgent("ctx-persist");

    await agent.setContextBlock("memory", "Fact 1: User likes cats.");
    await agent.testChat("Hello!");

    const content = await agent.getContextBlockContent("memory");
    expect(content).toBe("Fact 1: User likes cats.");
  });

  it("should use context blocks in assembleContext even when called directly", async () => {
    const agent = await freshSessionAgent("ctx-assemble-direct");

    await agent.setContextBlock("memory", "User prefers Rust over Go.");

    // Call assembleContext directly — without session.tools() being called first.
    // This verifies that assembleContext triggers context block loading on its own.
    const systemPrompt = await agent.getAssembledSystemPrompt();

    expect(systemPrompt).toContain("MEMORY");
    expect(systemPrompt).toContain("User prefers Rust over Go.");
  });

  it("should fall back to getSystemPrompt when no context blocks have content", async () => {
    const agent = await freshSessionAgent("ctx-fallback");

    // Don't write any content to the memory block — it starts empty.
    // assembleContext should fall back to getSystemPrompt().
    const systemPrompt = await agent.getAssembledSystemPrompt();

    // Default getSystemPrompt() returns "You are a helpful assistant."
    expect(systemPrompt).toBe("You are a helpful assistant.");
  });
});

// ── Async configureSession ───────────────────────────────────────

describe("Think — async configureSession", () => {
  it("should initialize and chat with async configureSession", async () => {
    const agent = await freshAsyncSessionAgent("async-cfg-basic");

    const result = await agent.testChat("Hello async!");
    expect(result.done).toBe(true);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("should have working context blocks from async config", async () => {
    const agent = await freshAsyncSessionAgent("async-cfg-ctx");

    await agent.setContextBlock("memory", "Async-configured fact.");

    const prompt = (await agent.getAssembledSystemPrompt()) as string;
    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("Async-configured fact.");
  });

  it("should support multiple turns after async init", async () => {
    const agent = await freshAsyncSessionAgent("async-cfg-multi");

    await agent.testChat("Turn 1");
    await agent.testChat("Turn 2");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
  });
});

// ── Dynamic configuration ────────────────────────────────────────

describe("Think — dynamic configuration", () => {
  it("should persist and retrieve typed configuration", async () => {
    const agent = await freshConfigAgent("config-basic");

    await agent.setTestConfig({ theme: "dark", maxTokens: 4000 });
    const config = await agent.getTestConfig();

    expect(config).not.toBeNull();
    expect(config!.theme).toBe("dark");
    expect(config!.maxTokens).toBe(4000);
  });

  it("should return null for unconfigured agent", async () => {
    const agent = await freshConfigAgent("config-empty");

    const config = await agent.getTestConfig();
    expect(config).toBeNull();
  });

  it("should overwrite configuration on re-configure", async () => {
    const agent = await freshConfigAgent("config-overwrite");

    await agent.setTestConfig({ theme: "light", maxTokens: 2000 });
    await agent.setTestConfig({ theme: "dark", maxTokens: 8000 });

    const config = await agent.getTestConfig();
    expect(config!.theme).toBe("dark");
    expect(config!.maxTokens).toBe(8000);
  });
});

// ── onChatResponse hook ──────────────────────────────────────────

describe("Think — onChatResponse", () => {
  it("should fire onChatResponse after successful chat turn", async () => {
    const agent = await freshAgent("hook-success");

    await agent.testChat("Hello!");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("completed");
    expect(log[0].continuation).toBe(false);
    expect(log[0].message.role).toBe("assistant");
    expect(log[0].requestId).toBeTruthy();
  });

  it("should fire onChatResponse with error status on failure", async () => {
    const agent = await freshAgent("hook-error");

    await agent.testChatWithError("Boom");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("error");
    expect(log[0].error).toContain("Boom");
  });

  it("should fire onChatResponse with aborted status on abort", async () => {
    const agent = await freshAgent("hook-abort");

    await agent.setMultiChunkResponse([
      "chunk1 ",
      "chunk2 ",
      "chunk3 ",
      "chunk4 "
    ]);
    await agent.testChatWithAbort("Abort me", 2);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("aborted");
  });

  it("should accumulate response hooks across multiple turns", async () => {
    const agent = await freshAgent("hook-multi");

    await agent.testChat("Turn 1");
    await agent.testChat("Turn 2");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(2);
    expect(log[0].status).toBe("completed");
    expect(log[1].status).toBe("completed");
  });
});

// ── Message sanitization ─────────────────────────────────────────

describe("Think — sanitization", () => {
  it("should strip OpenAI ephemeral itemId from providerMetadata", async () => {
    const agent = await freshAgent("sanitize-openai");

    const msg: UIMessage = {
      id: "test-1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Hello",
          providerMetadata: {
            openai: { itemId: "item_abc123", otherField: "keep" }
          }
        } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;
    const part = sanitized.parts[0] as Record<string, unknown>;
    const meta = part.providerMetadata as Record<string, unknown> | undefined;

    expect(meta).toBeDefined();
    expect(meta!.openai).toBeDefined();
    const openaiMeta = meta!.openai as Record<string, unknown>;
    expect(openaiMeta.itemId).toBeUndefined();
    expect(openaiMeta.otherField).toBe("keep");
  });

  it("should strip reasoningEncryptedContent from OpenAI metadata", async () => {
    const agent = await freshAgent("sanitize-reasoning-enc");

    const msg: UIMessage = {
      id: "test-2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Hello",
          providerMetadata: {
            openai: { reasoningEncryptedContent: "encrypted_data" }
          }
        } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;
    const part = sanitized.parts[0] as Record<string, unknown>;

    expect(part.providerMetadata).toBeUndefined();
  });

  it("should filter empty reasoning parts without providerMetadata", async () => {
    const agent = await freshAgent("sanitize-empty-reasoning");

    const msg: UIMessage = {
      id: "test-3",
      role: "assistant",
      parts: [
        { type: "text", text: "Hello" },
        { type: "reasoning", text: "" } as UIMessage["parts"][number],
        { type: "reasoning", text: "Thinking..." } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;

    expect(sanitized.parts).toHaveLength(2);
    expect(sanitized.parts[0].type).toBe("text");
    expect(sanitized.parts[1].type).toBe("reasoning");
  });

  it("should preserve reasoning parts with providerMetadata", async () => {
    const agent = await freshAgent("sanitize-keep-reasoning-meta");

    const msg: UIMessage = {
      id: "test-4",
      role: "assistant",
      parts: [
        { type: "text", text: "Hello" },
        {
          type: "reasoning",
          text: "",
          providerMetadata: {
            anthropic: { redactedData: "abc" }
          }
        } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;

    expect(sanitized.parts).toHaveLength(2);
  });

  it("should pass through messages without OpenAI metadata unchanged", async () => {
    const agent = await freshAgent("sanitize-noop");

    const msg: UIMessage = {
      id: "test-5",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;
    expect(sanitized.parts).toHaveLength(1);
    expect((sanitized.parts[0] as { text: string }).text).toBe("Hello");
  });
});

// ── Row size enforcement ─────────────────────────────────────────

describe("Think — row size enforcement", () => {
  it("should pass through small messages unchanged", async () => {
    const agent = await freshAgent("rowsize-small");

    const msg: UIMessage = {
      id: "small-1",
      role: "assistant",
      parts: [{ type: "text", text: "Short message" }]
    };

    const result = (await agent.enforceRowSizeLimit(msg)) as UIMessage;
    expect((result.parts[0] as { text: string }).text).toBe("Short message");
  });

  it("should compact large tool outputs", async () => {
    const agent = await freshAgent("rowsize-tool");

    const hugeOutput = "x".repeat(2_000_000);
    const msg: UIMessage = {
      id: "tool-big",
      role: "assistant",
      parts: [
        {
          type: "tool-read_file",
          toolCallId: "tc-1",
          toolName: "read_file",
          state: "output-available",
          input: {},
          output: hugeOutput
        } as UIMessage["parts"][number]
      ]
    };

    const result = (await agent.enforceRowSizeLimit(msg)) as UIMessage;
    const toolPart = result.parts[0] as Record<string, unknown>;
    const output = toolPart.output as string;

    expect(output).toContain("too large to persist");
    expect(output.length).toBeLessThan(hugeOutput.length);
  });

  it("should truncate large text parts for non-assistant messages", async () => {
    const agent = await freshAgent("rowsize-user-text");

    const hugeText = "y".repeat(2_000_000);
    const msg: UIMessage = {
      id: "user-big",
      role: "user",
      parts: [{ type: "text", text: hugeText }]
    };

    const result = (await agent.enforceRowSizeLimit(msg)) as UIMessage;
    const textPart = result.parts[0] as { text: string };

    expect(textPart.text).toContain("Text truncated");
    expect(textPart.text.length).toBeLessThan(hugeText.length);
  });
});

// ── saveMessages ─────────────────────────────────────────────────

describe("Think — saveMessages", () => {
  it("should inject messages and run a turn", async () => {
    const agent = await freshProgrammaticAgent("save-basic");

    const result = (await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Scheduled prompt" }]
      }
    ])) as SaveMessagesResult;

    expect(result.status).toBe("completed");
    expect(result.requestId).toBeTruthy();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("should support function form", async () => {
    const agent = await freshProgrammaticAgent("save-fn");

    // First turn via RPC
    await agent.testChat("Hello");

    // Second turn via saveMessages with function form
    const result = (await agent.testSaveMessagesWithFn(
      "Follow-up"
    )) as SaveMessagesResult;
    expect(result.status).toBe("completed");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("assistant");
  });

  it("should fire onChatResponse", async () => {
    const agent = await freshProgrammaticAgent("save-hook");

    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Trigger hook" }]
      }
    ]);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("completed");
    expect(log[0].continuation).toBe(false);
  });

  it("should broadcast to connected clients", async () => {
    const agent = await freshProgrammaticAgent("save-broadcast");

    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Broadcast test" }]
      }
    ]);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
  });
});

// ── continueLastTurn ─────────────────────────────────────────────

describe("Think — continueLastTurn", () => {
  it("should continue from the last assistant message", async () => {
    const agent = await freshProgrammaticAgent("continue-basic");

    await agent.testChat("Start conversation");
    const messagesBefore = (await agent.getStoredMessages()) as UIMessage[];
    expect(messagesBefore).toHaveLength(2);

    const result = (await agent.testContinueLastTurn()) as SaveMessagesResult;
    expect(result.status).toBe("completed");

    const messagesAfter = (await agent.getStoredMessages()) as UIMessage[];
    expect(messagesAfter.length).toBeGreaterThan(2);
  });

  it("should skip when no assistant message exists", async () => {
    const agent = await freshProgrammaticAgent("continue-skip");

    const result = (await agent.testContinueLastTurn()) as SaveMessagesResult;
    expect(result.status).toBe("skipped");
    expect(result.requestId).toBe("");
  });

  it("should set continuation: true on ChatMessageOptions", async () => {
    const agent = await freshProgrammaticAgent("continue-flag");

    await agent.testChat("Start");

    await agent.testContinueLastTurn();

    const options = (await agent.getCapturedOptions()) as Array<{
      continuation?: boolean;
    }>;
    const lastOption = options[options.length - 1];
    expect(lastOption.continuation).toBe(true);
  });

  it("should fire onChatResponse with continuation: true", async () => {
    const agent = await freshProgrammaticAgent("continue-hook");

    await agent.testChat("Start");
    await agent.testContinueLastTurn();

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBeGreaterThanOrEqual(2);
    const lastHook = log[log.length - 1];
    expect(lastHook.continuation).toBe(true);
    expect(lastHook.status).toBe("completed");
  });

  it("should accept custom body", async () => {
    const agent = await freshProgrammaticAgent("continue-body");

    await agent.testChat("Start");
    await agent.testContinueLastTurnWithBody({ model: "fast" });

    const options = (await agent.getCapturedOptions()) as Array<{
      body?: Record<string, unknown>;
    }>;
    const lastOption = options[options.length - 1];
    expect(lastOption.body).toEqual({ model: "fast" });
  });
});

// ── sanitizeMessageForPersistence ────────────────────────────────

describe("Think — sanitizeMessageForPersistence", () => {
  it("should redact SECRET from persisted messages", async () => {
    const agent = await freshSanitizeAgent("sanitize-redact");

    await agent.testChat("Tell me the password");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);

    const assistant = messages[1] as {
      role: string;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(assistant.role).toBe("assistant");
    const textParts = assistant.parts.filter((p) => p.type === "text");
    expect(textParts.length).toBeGreaterThan(0);

    for (const part of textParts) {
      expect(part.text).not.toContain("SECRET");
      expect(part.text).toContain("[REDACTED]");
    }
  });

  it("should not affect user messages", async () => {
    const agent = await freshSanitizeAgent("sanitize-user");

    await agent.testChat("Tell me a SECRET");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const userMsg = messages[0] as {
      parts: Array<{ type: string; text?: string }>;
    };
    const userText = userMsg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(userText).toContain("SECRET");
  });
});

// ── Custom body persistence ──────────────────────────────────────

describe("Think — body persistence", () => {
  it("should pass body from continueLastTurn", async () => {
    const agent = await freshProgrammaticAgent("body-continue");

    await agent.testChat("Start");
    await agent.testContinueLastTurnWithBody({
      model: "fast",
      temperature: 0.5
    });

    const options = (await agent.getCapturedOptions()) as Array<{
      body?: Record<string, unknown>;
    }>;
    const lastOption = options[options.length - 1];
    expect(lastOption.body).toEqual({ model: "fast", temperature: 0.5 });
  });

  it("should default to undefined when no body set", async () => {
    const agent = await freshProgrammaticAgent("body-default");

    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "No body" }]
      }
    ]);

    const options = (await agent.getCapturedOptions()) as Array<{
      body?: Record<string, unknown>;
    }>;
    expect(options[0].body).toBeUndefined();
  });
});
