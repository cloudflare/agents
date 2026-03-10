import { env } from "cloudflare:test";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { Env } from "./worker";
import type { ThinkTestAgent } from "./agents/think-session";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function freshAgent(name: string) {
  // Cast: ThinkTestAgent extends Think<Cloudflare.Env> but
  // the test Env has additional DO bindings. The runtime types align.
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
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

    const count = await agent.getMessageCount();
    expect(count).toBe(2); // user + assistant

    const history = await agent.getHistory();
    expect(history).toHaveLength(2);
    expect((history[0] as { role: string }).role).toBe("user");
    expect((history[1] as { role: string }).role).toBe("assistant");
  });

  it("should accumulate messages across multiple turns", async () => {
    const agent = await freshAgent("chat-multi");

    await agent.testChat("First message");
    await agent.testChat("Second message");

    const count = await agent.getMessageCount();
    expect(count).toBe(4); // 2 user + 2 assistant

    const history = await agent.getHistory();
    expect(history).toHaveLength(4);
    expect((history as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
  });

  it("should clear messages while preserving session", async () => {
    const agent = await freshAgent("chat-clear");

    await agent.testChat("Hello!");

    let count = await agent.getMessageCount();
    expect(count).toBe(2);

    await agent.clearMessages();

    count = await agent.getMessageCount();
    expect(count).toBe(0);

    const session = await agent.getSessionInfo();
    expect(session).not.toBeNull();
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

  it("should return empty history before first chat", async () => {
    const agent = await freshAgent("chat-empty");

    const history = await agent.getHistory();
    expect(history).toHaveLength(0);

    const count = await agent.getMessageCount();
    expect(count).toBe(0);
  });

  it("should return null session before first chat", async () => {
    const agent = await freshAgent("chat-no-session");

    const session = await agent.getSessionInfo();
    expect(session).toBeNull();
  });

  it("should use custom response from setResponse", async () => {
    const agent = await freshAgent("chat-custom-response");

    await agent.setResponse("Custom response text");
    const result = await agent.testChat("Say something");

    expect(result.done).toBe(true);

    const history = await agent.getHistory();
    expect(history).toHaveLength(2);
    const assistantMsg = history[1] as {
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

    const history = await agent.getHistory();
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

    // Use a response long enough to generate multiple chunks
    await agent.setResponse("This is a partial response");
    const result = await agent.testChatWithError("Mid-stream failure");

    expect(result.done).toBe(false);
    // Some events should have been collected before the error
    expect(result.events.length).toBeGreaterThan(0);

    // Should have user + partial assistant persisted
    const history = await agent.getHistory();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    // The partial message should have at least some parts built from chunks
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

    // First: error
    const errResult = await agent.testChatWithError("Temporary failure");
    expect(errResult.done).toBe(false);

    // Second: normal chat should work
    const okResult = await agent.testChat("After error");
    expect(okResult.done).toBe(true);

    // Should have: user1 + partial-assistant1 + user2 + assistant2
    const count = await agent.getMessageCount();
    expect(count).toBe(4);
  });
});

// ── Abort/cancel ─────────────────────────────────────────────────

describe("Think — abort", () => {
  it("should stop streaming on abort and not call onDone", async () => {
    const agent = await freshAgent("abort-basic");

    // Use multi-chunk model so there are enough events to abort between
    await agent.setMultiChunkResponse([
      "chunk1 ",
      "chunk2 ",
      "chunk3 ",
      "chunk4 ",
      "chunk5 "
    ]);

    // Abort after 2 events (the callback aborts the signal internally)
    const result = await agent.testChatWithAbort("Abort me", 2);

    // onDone should NOT have been called
    expect(result.doneCalled).toBe(false);

    // Some events collected before abort
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    // But not all events (5 text-deltas + start/end/finish would be ~8+)
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

    // Should have user + partial assistant persisted
    const history = await agent.getHistory();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    // Partial message should have some parts from the chunks before abort
    expect(assistantMsg.parts.length).toBeGreaterThan(0);
  });

  it("should recover and chat normally after abort", async () => {
    const agent = await freshAgent("abort-recover");

    await agent.setMultiChunkResponse(["a ", "b ", "c ", "d "]);
    await agent.testChatWithAbort("Abort this", 2);

    // Clear multi-chunk, use normal model
    await agent.clearMultiChunkResponse();
    const result = await agent.testChat("Normal after abort");
    expect(result.done).toBe(true);

    // Should have: user1 + partial-assistant1 + user2 + assistant2
    const count = await agent.getMessageCount();
    expect(count).toBe(4);
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

    const history = await agent.getHistory();
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

    const history = await agent.getHistory();
    const firstMsg = history[0] as {
      parts: Array<{ type: string; text?: string }>;
    };
    expect(firstMsg.parts).toHaveLength(2);
  });
});

// ── maxPersistedMessages ─────────────────────────────────────────

describe("Think — maxPersistedMessages", () => {
  it("should enforce storage bounds", async () => {
    const agent = await freshAgent("max-msgs");

    // Set max to 4 messages (2 turns = 4 messages)
    await agent.setMaxPersistedMessages(4);

    // First turn: 2 messages
    await agent.testChat("Turn 1");
    let count = await agent.getMessageCount();
    expect(count).toBe(2);

    // Second turn: 4 messages (at limit)
    await agent.testChat("Turn 2");
    count = await agent.getMessageCount();
    expect(count).toBe(4);

    // Third turn: would be 6, but should be trimmed to 4
    await agent.testChat("Turn 3");
    count = await agent.getMessageCount();
    expect(count).toBe(4);

    // Verify the oldest messages were removed
    const history = await agent.getHistory();
    expect(history).toHaveLength(4);
    // Should have turns 2 and 3 (turn 1 should be gone)
    const roles = (history as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("should not enforce bounds when maxPersistedMessages is null", async () => {
    const agent = await freshAgent("max-msgs-null");

    // Default: no limit
    await agent.testChat("Turn 1");
    await agent.testChat("Turn 2");
    await agent.testChat("Turn 3");

    const count = await agent.getMessageCount();
    expect(count).toBe(6); // 3 turns × 2 messages
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

    // providerMetadata must exist with openai.otherField preserved
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

    // With only reasoningEncryptedContent, openai key should be removed entirely
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

    // Empty reasoning should be removed, non-empty should remain
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

    // Empty reasoning WITH providerMetadata should be preserved
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

    // Create a message with a huge tool output
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

    // Output should be compacted (contains "too large" notice)
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
