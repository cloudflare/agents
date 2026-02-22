import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";
import { MessageType } from "../types";

describe("Row Size Guard and Incremental Persistence", () => {
  describe("Incremental persistence", () => {
    it("persists new messages and skips unchanged ones on second call", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Persist two messages
      const messages: ChatMessage[] = [
        {
          id: "inc-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        },
        {
          id: "inc-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }]
        }
      ];

      await agentStub.persistMessages(messages);

      let persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(2);

      // Persist the same messages again -- should be a no-op in SQL
      // (we can't directly observe SQL write count, but we can verify
      // the messages are still correct)
      await agentStub.persistMessages(messages);

      persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(2);
      expect(persisted[0].id).toBe("inc-1");
      expect(persisted[1].id).toBe("inc-2");

      ws.close(1000);
    });

    it("persists modified messages when content changes", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Persist initial message
      await agentStub.persistMessages([
        {
          id: "mod-1",
          role: "assistant",
          parts: [{ type: "text", text: "Original" }]
        }
      ]);

      // Modify the message
      await agentStub.persistMessages([
        {
          id: "mod-1",
          role: "assistant",
          parts: [{ type: "text", text: "Updated content" }]
        }
      ]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(1);
      const textPart = persisted[0].parts[0] as { text: string };
      expect(textPart.text).toBe("Updated content");

      ws.close(1000);
    });

    it("cache is cleared on chat clear", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Persist a message
      await agentStub.persistMessages([
        {
          id: "clear-cache-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ]);

      // Clear via WebSocket
      ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
      await new Promise((r) => setTimeout(r, 100));

      // Verify cleared
      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(0);

      // Persist a new message with the same ID -- should succeed
      // (cache was cleared, so it won't skip)
      await agentStub.persistMessages([
        {
          id: "clear-cache-1",
          role: "user",
          parts: [{ type: "text", text: "New message same ID" }]
        }
      ]);

      const afterPersist =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(afterPersist.length).toBe(1);
      expect((afterPersist[0].parts[0] as { text: string }).text).toBe(
        "New message same ID"
      );

      ws.close(1000);
    });
  });

  describe("Row size enforcement", () => {
    it("messages under 1.8MB pass through unchanged", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Create a message with a moderately large tool output (50KB)
      const toolOutput = "A".repeat(50_000);
      const message: ChatMessage = {
        id: "size-ok",
        role: "assistant",
        parts: [
          {
            type: "tool-bigTool",
            toolCallId: "call_ok",
            state: "output-available",
            input: {},
            output: toolOutput
          }
        ] as ChatMessage["parts"]
      };

      await agentStub.persistMessages([message]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(1);

      // Output should be preserved at full fidelity (under 1.8MB)
      const part = persisted[0].parts[0] as { output: unknown };
      expect(part.output).toBe(toolOutput);

      ws.close(1000);
    });

    it("messages over 1.8MB have tool outputs compacted", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Create a message with a huge tool output that pushes over 1.8MB
      const hugeOutput = "X".repeat(1_900_000);
      const message: ChatMessage = {
        id: "size-big",
        role: "assistant",
        parts: [
          {
            type: "tool-hugeTool",
            toolCallId: "call_huge",
            state: "output-available",
            input: { query: "big data" },
            output: hugeOutput
          }
        ] as ChatMessage["parts"]
      };

      // Should NOT throw -- the guard compacts the output
      await agentStub.persistMessages([message]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(1);

      // Output should be compacted (not the original huge string)
      const part = persisted[0].parts[0] as { output: unknown };
      const outputStr = part.output as string;
      expect(outputStr).toContain("too large to persist");
      expect(outputStr).toContain("bytes");
      expect(outputStr.length).toBeLessThan(hugeOutput.length);

      ws.close(1000);
    });

    it("compacted messages have metadata with compactedToolOutputs", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const message: ChatMessage = {
        id: "meta-compact",
        role: "assistant",
        parts: [
          {
            type: "tool-bigTool",
            toolCallId: "call_meta",
            state: "output-available",
            input: {},
            output: "Y".repeat(1_900_000)
          }
        ] as ChatMessage["parts"]
      };

      await agentStub.persistMessages([message]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      const metadata = persisted[0].metadata as Record<string, unknown>;
      expect(metadata).toBeDefined();
      expect(metadata.compactedToolOutputs).toEqual(["call_meta"]);

      ws.close(1000);
    });

    it("non-assistant messages pass through even if large", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // A large user message (no tool outputs to compact)
      // This tests the text truncation fallback for non-assistant messages
      const largeText = "Z".repeat(1_900_000);
      const message: ChatMessage = {
        id: "user-big",
        role: "user",
        parts: [{ type: "text", text: largeText }]
      };

      // Should not crash
      await agentStub.persistMessages([message]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(1);

      // Text should be truncated
      const textPart = persisted[0].parts[0] as { text: string };
      expect(textPart.text).toContain("truncated for storage");
      expect(textPart.text.length).toBeLessThan(largeText.length);

      ws.close(1000);
    });
  });

  describe("Unicode byte-length measurement", () => {
    it("compacts messages with multi-byte Unicode that exceed byte limit", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // CJK character \u4e00 is 1 JS char but 3 bytes in UTF-8.
      // 700,000 CJK chars = 700,000 JS chars (under 1.8M char limit)
      // but 2,100,000 UTF-8 bytes (over 1.8MB byte limit).
      // This tests that the byte-length guard catches it.
      const cjkOutput = "\u4e00".repeat(700_000);

      const message: ChatMessage = {
        id: "unicode-test",
        role: "assistant",
        parts: [
          {
            type: "tool-cjkTool",
            toolCallId: "call_unicode",
            state: "output-available",
            input: {},
            output: cjkOutput
          }
        ] as ChatMessage["parts"]
      };

      await agentStub.persistMessages([message]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(1);

      // The tool output should be compacted (byte size exceeds limit)
      const part = persisted[0].parts[0] as { output: unknown };
      expect(typeof part.output).toBe("string");
      expect((part.output as string).length).toBeLessThan(cjkOutput.length);
      expect(part.output as string).toContain("too large to persist");

      ws.close(1000);
    });
  });

  describe("Stream chunk size guard", () => {
    it("normal chunks are stored", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-chunk-ok");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","delta":"hello"}'
      );
      await agentStub.testFlushChunkBuffer();

      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(1);

      ws.close(1000);
    });

    it("oversized chunks are skipped without crash", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-chunk-big");

      // Store a normal chunk first
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );

      // Store an oversized chunk (>1.8MB) -- should be skipped
      const hugeChunk =
        '{"type":"tool-output-available","output":"' +
        "X".repeat(1_900_000) +
        '"}';
      await agentStub.testStoreStreamChunk(streamId, hugeChunk);

      // Store another normal chunk after
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-end","id":"t1"}'
      );

      await agentStub.testFlushChunkBuffer();

      const chunks = await agentStub.getStreamChunks(streamId);
      // Should have 2 chunks (the oversized one was skipped)
      expect(chunks.length).toBe(2);
      expect(chunks[0].body).toContain("text-start");
      expect(chunks[1].body).toContain("text-end");

      ws.close(1000);
    });
  });
});
