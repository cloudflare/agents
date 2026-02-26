import type { UIMessage } from "ai";
import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import type { Env } from "../../../worker";
import { getAgentByName } from "../../../..";
import type {
  MessageQueryOptions,
  CompactResult
} from "../../../../experimental/memory/session";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Typed stub interface for TestSessionAgent
 */
interface SessionAgentStub {
  getMessages(): Promise<UIMessage[]>;
  getMessagesWithOptions(options: MessageQueryOptions): Promise<UIMessage[]>;
  appendMessage(message: UIMessage): Promise<void>;
  appendMessages(messages: UIMessage[]): Promise<void>;
  updateMessage(message: UIMessage): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  clearMessages(): Promise<void>;
  getMessage(id: string): Promise<UIMessage | null>;
  getLastMessages(n: number): Promise<UIMessage[]>;
  compact(): Promise<CompactResult>;
}

/** Helper to get a typed agent stub */
async function getSessionAgent(name: string): Promise<SessionAgentStub> {
  return getAgentByName(
    env.TestSessionAgent,
    name
  ) as unknown as Promise<SessionAgentStub>;
}

async function getSessionAgentNoMicroCompact(
  name: string
): Promise<SessionAgentStub> {
  return getAgentByName(
    env.TestSessionAgentNoMicroCompaction,
    name
  ) as unknown as Promise<SessionAgentStub>;
}

async function getSessionAgentCustomRules(
  name: string
): Promise<SessionAgentStub> {
  return getAgentByName(
    env.TestSessionAgentCustomRules,
    name
  ) as unknown as Promise<SessionAgentStub>;
}

describe("AgentSessionProvider", () => {
  let instanceName: string;

  beforeEach(() => {
    instanceName = `session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  describe("basic operations", () => {
    it("should start with no messages", async () => {
      const agent = await getSessionAgent(instanceName);
      const messages = await agent.getMessages();

      expect(messages).toEqual([]);
    });

    it("should append and retrieve a single message", async () => {
      const agent = await getSessionAgent(instanceName);

      const message: UIMessage = {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Hello, world!" }]
      };

      await agent.appendMessage(message);
      const messages = await agent.getMessages();

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-1");
      expect(messages[0].role).toBe("user");
      expect(messages[0].parts[0]).toEqual({
        type: "text",
        text: "Hello, world!"
      });
    });

    it("should append multiple messages at once", async () => {
      const agent = await getSessionAgent(instanceName);

      const messages: UIMessage[] = [
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }]
        },
        {
          id: "msg-3",
          role: "user",
          parts: [{ type: "text", text: "How are you?" }]
        }
      ];

      await agent.appendMessages(messages);
      const retrieved = await agent.getMessages();

      expect(retrieved).toHaveLength(3);
      expect(retrieved.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
    });

    it("should get a single message by ID", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        }
      ]);

      const message = await agent.getMessage("msg-2");
      expect(message).not.toBeNull();
      expect(message?.id).toBe("msg-2");
      expect(message?.role).toBe("assistant");

      const notFound = await agent.getMessage("nonexistent");
      expect(notFound).toBeNull();
    });

    it("should get the last N messages", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "Fourth" }]
        }
      ]);

      const lastTwo = await agent.getLastMessages(2);
      expect(lastTwo).toHaveLength(2);
      expect(lastTwo.map((m) => m.id)).toEqual(["msg-3", "msg-4"]);
    });
  });

  describe("update and delete", () => {
    it("should update an existing message", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Original" }]
      });

      await agent.updateMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Updated" }]
      });

      const messages = await agent.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].parts[0]).toEqual({ type: "text", text: "Updated" });
    });

    it("should upsert on append with existing ID", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Original" }]
      });

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Replaced" }]
      });

      const messages = await agent.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].parts[0]).toEqual({ type: "text", text: "Replaced" });
    });

    it("should delete messages by ID", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] }
      ]);

      await agent.deleteMessages(["msg-2"]);

      const messages = await agent.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-3"]);
    });

    it("should clear all messages", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        }
      ]);

      await agent.clearMessages();

      const messages = await agent.getMessages();
      expect(messages).toEqual([]);
    });
  });

  describe("query options", () => {
    it("should limit results", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] }
      ]);

      const messages = await agent.getMessagesWithOptions({ limit: 2 });
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    });

    it("should offset results", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] }
      ]);

      const messages = await agent.getMessagesWithOptions({ offset: 1 });
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-2", "msg-3"]);
    });

    it("should filter by role", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "User 1" }]
        },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Assistant 1" }]
        },
        {
          id: "msg-3",
          role: "user",
          parts: [{ type: "text", text: "User 2" }]
        },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "Assistant 2" }]
        }
      ]);

      const userMessages = await agent.getMessagesWithOptions({ role: "user" });
      expect(userMessages).toHaveLength(2);
      expect(userMessages.every((m) => m.role === "user")).toBe(true);

      const assistantMessages = await agent.getMessagesWithOptions({
        role: "assistant"
      });
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages.every((m) => m.role === "assistant")).toBe(true);
    });
  });

  describe("microCompaction", () => {
    it("should truncate tool outputs on append", async () => {
      const agent = await getSessionAgentCustomRules(instanceName);

      // Add messages with large tool output (keepRecent=2, so first 2 get compacted)
      const largeOutput = "x".repeat(500);
      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [
            {
              type: "tool-invocation",
              toolCallId: "call-1",
              input: {},
              state: "output-available",
              output: largeOutput
            }
          ]
        },
        {
          id: "msg-3",
          role: "user",
          parts: [{ type: "text", text: "Thanks" }]
        },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "You're welcome" }]
        }
      ]);

      // microCompaction runs automatically on append — check results
      const messages = await agent.getMessages();
      expect(messages).toHaveLength(4);

      // msg-2 (older) should have truncated output
      const msg2 = messages.find((m) => m.id === "msg-2");
      expect(msg2).toBeDefined();
      const toolPart = msg2?.parts[0] as { output?: unknown };
      expect(typeof toolPart.output).toBe("string");
      expect((toolPart.output as string).includes("[Truncated")).toBe(true);
    });

    it("should truncate long text parts in older messages on append", async () => {
      const agent = await getSessionAgentCustomRules(instanceName);

      const longText = "y".repeat(500);
      await agent.appendMessages([
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: longText }]
        },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Short" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "Hi" }]
        }
      ]);

      // microCompaction runs automatically on append
      const messages = await agent.getMessages();
      const msg1 = messages.find((m) => m.id === "msg-1");
      const textPart = msg1?.parts[0] as { text?: string };
      expect(textPart.text?.includes("[truncated")).toBe(true);
      expect(textPart.text?.length).toBeLessThan(longText.length);
    });

    it("should keep recent messages intact", async () => {
      const agent = await getSessionAgentCustomRules(instanceName);

      // Custom rules: keepRecent = 2
      const longText = "z".repeat(500);
      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "Old" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Also old" }]
        },
        {
          id: "msg-3",
          role: "user",
          parts: [{ type: "text", text: longText }]
        }, // Recent
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: longText }]
        } // Recent
      ]);

      // microCompaction runs on append — recent messages should be intact
      const messages = await agent.getMessages();

      // msg-3 and msg-4 are recent (keepRecent=2), should not be truncated
      const msg3 = messages.find((m) => m.id === "msg-3");
      const msg4 = messages.find((m) => m.id === "msg-4");

      expect((msg3!.parts[0] as { text: string }).text).toBe(longText);
      expect((msg4!.parts[0] as { text: string }).text).toBe(longText);
    });

    it("should not truncate when microCompaction is disabled", async () => {
      const agent = await getSessionAgentNoMicroCompact(instanceName);

      const longText = "a".repeat(5000);
      await agent.appendMessages([
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: longText }]
        },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Bye" }] },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "Goodbye" }]
        }
      ]);

      // microCompaction disabled — nothing should be truncated
      const messages = await agent.getMessages();
      const msg1 = messages.find((m) => m.id === "msg-1");

      expect((msg1!.parts[0] as { text: string }).text).toBe(longText);
    });
  });

  describe("persistence", () => {
    it("should persist messages across agent instance lookups", async () => {
      const agent1 = await getSessionAgent(instanceName);
      await agent1.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }]
        }
      ]);

      const agent2 = await getSessionAgent(instanceName);
      const messages = await agent2.getMessages();

      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    });
  });

  describe("input validation", () => {
    it("should reject negative limit", async () => {
      const agent = await getSessionAgent(instanceName);
      try {
        await agent.getMessagesWithOptions({ limit: -1 });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain("limit must be a non-negative integer");
      }
    });

    it("should reject negative offset", async () => {
      const agent = await getSessionAgent(instanceName);
      try {
        await agent.getMessagesWithOptions({ offset: -1 });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain("offset must be a non-negative integer");
      }
    });

    it("should reject non-integer limit", async () => {
      const agent = await getSessionAgent(instanceName);
      try {
        await agent.getMessagesWithOptions({ limit: 1.5 });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain("limit must be a non-negative integer");
      }
    });
  });

  describe("date filtering", () => {
    it("should filter messages with before", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "First" }]
      });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 50));
      const midpoint = new Date();
      await new Promise((r) => setTimeout(r, 50));

      await agent.appendMessage({
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "Second" }]
      });

      const before = await agent.getMessagesWithOptions({ before: midpoint });
      expect(before).toHaveLength(1);
      expect(before[0].id).toBe("msg-1");
    });

    it("should filter messages with after", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "First" }]
      });

      await new Promise((r) => setTimeout(r, 50));
      const midpoint = new Date();
      await new Promise((r) => setTimeout(r, 50));

      await agent.appendMessage({
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "Second" }]
      });

      const after = await agent.getMessagesWithOptions({ after: midpoint });
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe("msg-2");
    });

    it("should filter with role + before combined", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "U1" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "A1" }]
        }
      ]);

      await new Promise((r) => setTimeout(r, 50));
      const midpoint = new Date();
      await new Promise((r) => setTimeout(r, 50));

      await agent.appendMessages([
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "U2" }] },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "A2" }]
        }
      ]);

      const result = await agent.getMessagesWithOptions({
        role: "user",
        before: midpoint
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("msg-1");
    });
  });

  describe("timestamp preservation", () => {
    it("should preserve created_at after compact", async () => {
      const agent = await getSessionAgent(instanceName);

      // Append messages with timestamps spread apart
      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      });
      await new Promise((r) => setTimeout(r, 50));
      const midpoint = new Date();
      await new Promise((r) => setTimeout(r, 50));
      await agent.appendMessage({
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }]
      });
      await agent.appendMessage({
        id: "msg-3",
        role: "user",
        parts: [{ type: "text", text: "Bye" }]
      });

      // Compact
      await agent.compact();

      // Verify before/after filtering still works (timestamps preserved)
      const before = await agent.getMessagesWithOptions({ before: midpoint });
      expect(before).toHaveLength(1);
      expect(before[0].id).toBe("msg-1");

      const after = await agent.getMessagesWithOptions({ after: midpoint });
      expect(after).toHaveLength(2);
      expect(after.map((m) => m.id)).toEqual(["msg-2", "msg-3"]);
    });
  });
});
