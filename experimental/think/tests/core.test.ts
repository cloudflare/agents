import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ThinkMessage } from "../src/shared";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function makeMessage(
  role: "user" | "assistant",
  content: string
): ThinkMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    createdAt: Date.now()
  };
}

function getChat(name: string) {
  return env.Chat.get(env.Chat.idFromName(name));
}

// ── Basic CRUD ───────────────────────────────────────────────────────

describe("Chat (facet)", () => {
  describe("getMessages", () => {
    it("returns empty array on fresh instance", async () => {
      const chat = getChat(`fresh-${crypto.randomUUID()}`);
      const messages = await chat.getMessages();
      expect(messages).toEqual([]);
    });
  });

  describe("addMessage", () => {
    it("adds a message and returns updated array", async () => {
      const chat = getChat(`add-${crypto.randomUUID()}`);
      const msg = makeMessage("user", "hello via RPC");
      const result = await chat.addMessage(msg);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(msg.id);
      expect(result[0].content).toBe("hello via RPC");
      expect(result[0].role).toBe("user");
    });

    it("maintains insertion order", async () => {
      const chat = getChat(`order-${crypto.randomUUID()}`);
      await chat.addMessage(makeMessage("user", "first"));
      await chat.addMessage(makeMessage("assistant", "second"));
      const result = await chat.addMessage(makeMessage("user", "third"));

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe("first");
      expect(result[1].content).toBe("second");
      expect(result[2].content).toBe("third");
    });

    it("is idempotent for same id (upsert)", async () => {
      const chat = getChat(`upsert-${crypto.randomUUID()}`);
      const msg = makeMessage("user", "original");
      await chat.addMessage(msg);

      const updated = { ...msg, content: "updated" };
      const result = await chat.addMessage(updated);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("updated");
    });
  });

  describe("deleteMessage", () => {
    it("removes a message by id", async () => {
      const chat = getChat(`delete-${crypto.randomUUID()}`);
      const m1 = makeMessage("user", "keep");
      const m2 = makeMessage("user", "remove");
      await chat.addMessage(m1);
      await chat.addMessage(m2);

      const result = await chat.deleteMessage(m2.id);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(m1.id);
    });

    it("returns unchanged array for non-existent id", async () => {
      const chat = getChat(`delete-missing-${crypto.randomUUID()}`);
      const msg = makeMessage("user", "still here");
      await chat.addMessage(msg);

      const result = await chat.deleteMessage("does-not-exist");
      expect(result).toHaveLength(1);
    });
  });

  describe("clearMessages", () => {
    it("removes all messages", async () => {
      const chat = getChat(`clear-${crypto.randomUUID()}`);
      await chat.addMessage(makeMessage("user", "a"));
      await chat.addMessage(makeMessage("assistant", "b"));

      await chat.clearMessages();
      const result = await chat.getMessages();

      expect(result).toEqual([]);
    });
  });

  describe("persistence", () => {
    it("messages survive across stub calls", async () => {
      const name = `persist-${crypto.randomUUID()}`;
      const chat1 = getChat(name);
      const msg = makeMessage("user", "I persist");
      await chat1.addMessage(msg);

      const chat2 = getChat(name);
      const result = await chat2.getMessages();

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("I persist");
    });
  });

  describe("thread isolation", () => {
    it("different Chat instances have independent storage", async () => {
      const chatA = getChat(`iso-a-${crypto.randomUUID()}`);
      const chatB = getChat(`iso-b-${crypto.randomUUID()}`);

      await chatA.addMessage(makeMessage("user", "only in A"));
      await chatB.addMessage(makeMessage("user", "only in B"));

      expect((await chatA.getMessages())[0].content).toBe("only in A");
      expect((await chatB.getMessages())[0].content).toBe("only in B");
    });
  });
});

// ── persistMessages (batch) ──────────────────────────────────────────

describe("Chat.persistMessages", () => {
  it("persists a full array in one call", async () => {
    const chat = getChat(`batch-${crypto.randomUUID()}`);
    const msgs = [
      makeMessage("user", "one"),
      makeMessage("assistant", "two"),
      makeMessage("user", "three")
    ];

    const result = await chat.persistMessages(msgs);

    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("one");
    expect(result[1].content).toBe("two");
    expect(result[2].content).toBe("three");
  });

  it("is incremental — unchanged messages skip SQL writes", async () => {
    const chat = getChat(`incremental-${crypto.randomUUID()}`);
    const msg1 = makeMessage("user", "stable");
    const msg2 = makeMessage("assistant", "will change");

    await chat.persistMessages([msg1, msg2]);

    const updated2 = { ...msg2, content: "changed" };
    const result = await chat.persistMessages([msg1, updated2]);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("stable");
    expect(result[1].content).toBe("changed");
  });

  it("handles deletions — messages removed from array are deleted", async () => {
    const chat = getChat(`batch-delete-${crypto.randomUUID()}`);
    const m1 = makeMessage("user", "keep");
    const m2 = makeMessage("assistant", "remove");
    await chat.persistMessages([m1, m2]);

    const result = await chat.persistMessages([m1]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(m1.id);
  });

  it("handles complete replacement", async () => {
    const chat = getChat(`replace-${crypto.randomUUID()}`);
    await chat.persistMessages([
      makeMessage("user", "old1"),
      makeMessage("assistant", "old2")
    ]);

    const newMsgs = [
      makeMessage("user", "new1"),
      makeMessage("assistant", "new2")
    ];
    const result = await chat.persistMessages(newMsgs);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("new1");
    expect(result[1].content).toBe("new2");
  });
});

// ── Row size limits ──────────────────────────────────────────────────

describe("Chat row size limits", () => {
  it("persists normal messages without modification", async () => {
    const chat = getChat(`normal-size-${crypto.randomUUID()}`);
    const msg = makeMessage("user", "small message");
    const result = await chat.addMessage(msg);

    expect(result[0].content).toBe("small message");
  });

  it("truncates oversized string fields to fit", async () => {
    const chat = getChat(`oversized-${crypto.randomUUID()}`);
    const hugeContent = "x".repeat(2_000_000);
    const msg = makeMessage("user", hugeContent);
    const result = await chat.addMessage(msg);

    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBeLessThan(hugeContent.length);
    expect(result[0].content).toContain("Truncated for storage");
    expect(result[0].content).toContain("Preview:");
  });

  it("preserves the message id during truncation", async () => {
    const chat = getChat(`trunc-id-${crypto.randomUUID()}`);
    const msg = makeMessage("user", "y".repeat(2_000_000));
    const result = await chat.addMessage(msg);

    expect(result[0].id).toBe(msg.id);
  });
});

// ── maxPersistedMessages ─────────────────────────────────────────────

describe("Chat.maxPersistedMessages", () => {
  it("evicts oldest messages when limit is exceeded", async () => {
    const chat = getChat(`max-${crypto.randomUUID()}`);
    // Set limit via persistMessages after adding
    // We'll add 5 messages then set limit to 3
    const msgs = Array.from({ length: 5 }, (_, i) =>
      makeMessage("user", `msg-${i}`)
    );
    for (const m of msgs) {
      await chat.addMessage(m);
    }

    // Now set maxPersistedMessages and trigger eviction via persistMessages
    await chat.setMaxPersistedMessages(3);
    // Trigger eviction by persisting current set
    const current = await chat.getMessages();
    const result = await chat.persistMessages(current);

    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("msg-2");
    expect(result[1].content).toBe("msg-3");
    expect(result[2].content).toBe("msg-4");
  });

  it("does nothing when under the limit", async () => {
    const chat = getChat(`under-limit-${crypto.randomUUID()}`);
    await chat.setMaxPersistedMessages(10);
    await chat.addMessage(makeMessage("user", "one"));
    await chat.addMessage(makeMessage("assistant", "two"));

    const result = await chat.getMessages();
    expect(result).toHaveLength(2);
  });
});

// ── Message sanitization ─────────────────────────────────────────────

describe("Chat message sanitization", () => {
  it("strips openai.itemId from providerMetadata", async () => {
    const chat = getChat(`sanitize-${crypto.randomUUID()}`);
    const msg = {
      id: "sanitize-1",
      role: "assistant" as const,
      content: "hello",
      createdAt: Date.now(),
      parts: [
        {
          type: "text",
          text: "hello",
          providerMetadata: {
            openai: {
              itemId: "item_abc123",
              someOtherField: "keep"
            }
          }
        }
      ]
    };

    const result = await chat.addMessage(msg as ThinkMessage);
    const stored = result[0] as Record<string, unknown>;
    const parts = stored.parts as Array<Record<string, unknown>>;
    const meta = parts[0].providerMetadata as
      | Record<string, unknown>
      | undefined;

    if (meta?.openai) {
      const openai = meta.openai as Record<string, unknown>;
      expect(openai.itemId).toBeUndefined();
      expect(openai.someOtherField).toBe("keep");
    }
  });

  it("filters out empty reasoning parts", async () => {
    const chat = getChat(`reasoning-${crypto.randomUUID()}`);
    const msg = {
      id: "reasoning-1",
      role: "assistant" as const,
      content: "",
      createdAt: Date.now(),
      parts: [
        { type: "reasoning", text: "" },
        { type: "reasoning", text: "  " },
        { type: "reasoning", text: "actual reasoning" },
        { type: "text", text: "response" }
      ]
    };

    const result = await chat.addMessage(msg as ThinkMessage);
    const stored = result[0] as Record<string, unknown>;
    const parts = stored.parts as Array<Record<string, unknown>>;

    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("reasoning");
    expect(parts[0].text).toBe("actual reasoning");
    expect(parts[1].type).toBe("text");
  });

  it("passes through messages without providerMetadata unchanged", async () => {
    const chat = getChat(`passthrough-${crypto.randomUUID()}`);
    const msg = makeMessage("user", "normal message");
    const result = await chat.addMessage(msg);

    expect(result[0].content).toBe("normal message");
  });
});

// ── Tool state tracking ──────────────────────────────────────────────

function makeToolMessage(toolCallId: string, state: string) {
  return {
    id: `tool-msg-${crypto.randomUUID().slice(0, 8)}`,
    role: "assistant" as const,
    content: "",
    createdAt: Date.now(),
    parts: [
      { type: "text", text: "Let me check that." },
      {
        type: `tool-getWeather`,
        toolCallId,
        toolName: "getWeather",
        state,
        input: { city: "Paris" }
      }
    ]
  };
}

describe("Chat tool state tracking", () => {
  it("applies a tool result to a persisted message", async () => {
    const chat = getChat(`tool-result-${crypto.randomUUID()}`);
    const toolCallId = `tc-${crypto.randomUUID().slice(0, 8)}`;
    const msg = makeToolMessage(toolCallId, "input-available");

    await chat.addMessage(msg as ThinkMessage);
    const applied = await chat.applyToolResult(toolCallId, {
      temperature: 22
    });

    expect(applied).toBe(true);

    const messages = await chat.getMessages();
    const stored = messages[0] as Record<string, unknown>;
    const parts = stored.parts as Array<Record<string, unknown>>;
    const toolPart = parts.find((p) => p.toolCallId === toolCallId);

    expect(toolPart).toBeDefined();
    expect(toolPart!.state).toBe("output-available");
    expect(toolPart!.output).toEqual({ temperature: 22 });
  });

  it("returns false for non-existent toolCallId", async () => {
    const chat = getChat(`tool-missing-${crypto.randomUUID()}`);
    await chat.addMessage(makeMessage("user", "hello"));

    const applied = await chat.applyToolResult("nonexistent", {});
    expect(applied).toBe(false);
  });

  it("returns false when tool is in wrong state", async () => {
    const chat = getChat(`tool-wrongstate-${crypto.randomUUID()}`);
    const toolCallId = `tc-${crypto.randomUUID().slice(0, 8)}`;
    const msg = makeToolMessage(toolCallId, "output-available");

    await chat.addMessage(msg as ThinkMessage);
    const applied = await chat.applyToolResult(toolCallId, {});
    expect(applied).toBe(false);
  });

  it("applies tool approval", async () => {
    const chat = getChat(`tool-approval-${crypto.randomUUID()}`);
    const toolCallId = `tc-${crypto.randomUUID().slice(0, 8)}`;
    const msg = makeToolMessage(toolCallId, "approval-requested");

    await chat.addMessage(msg as ThinkMessage);
    const applied = await chat.applyToolApproval(toolCallId, true);

    expect(applied).toBe(true);

    const messages = await chat.getMessages();
    const stored = messages[0] as Record<string, unknown>;
    const parts = stored.parts as Array<Record<string, unknown>>;
    const toolPart = parts.find((p) => p.toolCallId === toolCallId);

    expect(toolPart!.state).toBe("approval-responded");
    expect(toolPart!.approval).toEqual({ approved: true });
  });

  it("denies tool approval", async () => {
    const chat = getChat(`tool-deny-${crypto.randomUUID()}`);
    const toolCallId = `tc-${crypto.randomUUID().slice(0, 8)}`;
    const msg = makeToolMessage(toolCallId, "input-available");

    await chat.addMessage(msg as ThinkMessage);
    const applied = await chat.applyToolApproval(toolCallId, false);

    expect(applied).toBe(true);

    const messages = await chat.getMessages();
    const stored = messages[0] as Record<string, unknown>;
    const parts = stored.parts as Array<Record<string, unknown>>;
    const toolPart = parts.find((p) => p.toolCallId === toolCallId);

    expect(toolPart!.state).toBe("approval-responded");
    expect(toolPart!.approval).toEqual({ approved: false });
  });
});

// ── Streaming message management ─────────────────────────────────────

describe("Chat streaming message", () => {
  it("tracks a streaming message", async () => {
    const chat = getChat(`stream-track-${crypto.randomUUID()}`);
    const msg = {
      id: "stream-1",
      role: "assistant" as const,
      content: "",
      createdAt: Date.now(),
      parts: [{ type: "text", text: "partial..." }]
    };

    await chat.startStreamingMessage(msg as ThinkMessage);
    const streaming = await chat.getStreamingMessage();
    expect(streaming).not.toBeNull();
    expect(streaming!.id).toBe("stream-1");
  });

  it("completes streaming and persists the message", async () => {
    const chat = getChat(`stream-complete-${crypto.randomUUID()}`);
    await chat.addMessage(makeMessage("user", "hello"));

    const assistantMsg = {
      id: "stream-2",
      role: "assistant" as const,
      content: "",
      createdAt: Date.now(),
      parts: [{ type: "text", text: "Here is my response" }]
    };

    await chat.startStreamingMessage(assistantMsg as ThinkMessage);
    const result = await chat.completeStreamingMessage();

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("hello");
    expect((result[1] as Record<string, unknown>).id).toBe("stream-2");

    const streaming = await chat.getStreamingMessage();
    expect(streaming).toBeNull();
  });

  it("applies tool result to streaming message", async () => {
    const chat = getChat(`stream-tool-${crypto.randomUUID()}`);
    const toolCallId = `tc-${crypto.randomUUID().slice(0, 8)}`;

    const msg = {
      id: "stream-3",
      role: "assistant" as const,
      content: "",
      createdAt: Date.now(),
      parts: [
        { type: "text", text: "Checking..." },
        {
          type: "tool-getWeather",
          toolCallId,
          toolName: "getWeather",
          state: "input-available",
          input: { city: "London" }
        }
      ]
    };

    await chat.startStreamingMessage(msg as ThinkMessage);
    const applied = await chat.applyToolResult(toolCallId, {
      temp: 15
    });

    expect(applied).toBe(true);

    const streaming = await chat.getStreamingMessage();
    const parts = (streaming as unknown as Record<string, unknown>)
      .parts as Array<Record<string, unknown>>;
    const toolPart = parts.find((p) => p.toolCallId === toolCallId);
    expect(toolPart!.state).toBe("output-available");
    expect(toolPart!.output).toEqual({ temp: 15 });
  });

  it("completeStreamingMessage is a no-op when not streaming", async () => {
    const chat = getChat(`stream-noop-${crypto.randomUUID()}`);
    await chat.addMessage(makeMessage("user", "hello"));

    const result = await chat.completeStreamingMessage();
    expect(result).toHaveLength(1);
  });

  it("clearMessages clears streaming message", async () => {
    const chat = getChat(`stream-clear-${crypto.randomUUID()}`);
    const msg = {
      id: "stream-4",
      role: "assistant" as const,
      content: "",
      createdAt: Date.now(),
      parts: []
    };
    await chat.startStreamingMessage(msg as ThinkMessage);
    await chat.clearMessages();

    const streaming = await chat.getStreamingMessage();
    expect(streaming).toBeNull();
  });
});

// Abort/cancel tests moved to agent-facet.test.ts (inherited from AgentFacet)

// ── Reasoning field persistence ──────────────────────────────────────

describe("Chat reasoning field persistence", () => {
  it("persists a message with a reasoning field", async () => {
    const chat = getChat(`reasoning-${crypto.randomUUID()}`);
    const msg: ThinkMessage = {
      id: "r-1",
      role: "assistant",
      content: "2 + 2 = 4",
      reasoning: "The user asked a simple math question.",
      createdAt: Date.now()
    };
    await chat.addMessage(msg);
    const messages = await chat.getMessages();
    expect(messages[0].reasoning).toBe(
      "The user asked a simple math question."
    );
  });

  it("reasoning field survives storage roundtrip (hibernation simulation)", async () => {
    const name = `reasoning-persist-${crypto.randomUUID()}`;
    const chat1 = getChat(name);
    await chat1.addMessage({
      id: "r-2",
      role: "assistant",
      content: "The answer is 42",
      reasoning: "Thinking deeply...",
      createdAt: Date.now()
    });

    const chat2 = getChat(name);
    const messages = await chat2.getMessages();
    expect(messages[0].reasoning).toBe("Thinking deeply...");
    expect(messages[0].content).toBe("The answer is 42");
  });

  it("messages without reasoning field remain unchanged", async () => {
    const chat = getChat(`no-reasoning-${crypto.randomUUID()}`);
    await chat.addMessage(makeMessage("user", "Hello"));
    const messages = await chat.getMessages();
    expect((messages[0] as Record<string, unknown>).reasoning).toBeUndefined();
  });

  it("reasoning field included in batch persistMessages", async () => {
    const chat = getChat(`reasoning-batch-${crypto.randomUUID()}`);
    const msgs: ThinkMessage[] = [
      makeMessage("user", "what is 1+1?"),
      {
        id: "r-batch",
        role: "assistant",
        content: "2",
        reasoning: "Simple addition.",
        createdAt: Date.now()
      }
    ];
    await chat.persistMessages(msgs);
    const result = await chat.getMessages();
    expect(result[1].reasoning).toBe("Simple addition.");
  });
});
