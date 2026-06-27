import { env } from "cloudflare:workers";
import { evictAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { describe, expect, it } from "vitest";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

// These tests use the real `evictDurableObject` / `evictAllDurableObjects`
// helpers (vitest-pool-workers >= 0.16.20) to tear the DO instance down the
// way production eviction/hibernation does: in-memory state is dropped and the
// next access re-runs the AIChatAgent constructor, which must rebuild
// `this.messages`, the ResumableStream, request context, etc. from SQLite.
//
// This is strictly more realistic than the in-process `testSimulateHibernationWake`
// hook used by resumable-streaming.test.ts (which only re-instantiates the
// ResumableStream on the *same* live instance) — here the whole DO is recycled.

function isStreamResumingMessage(
  m: unknown
): m is Extract<
  OutgoingMessage,
  { type: MessageType.CF_AGENT_STREAM_RESUMING }
> {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    m.type === MessageType.CF_AGENT_STREAM_RESUMING
  );
}

function collectMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    try {
      messages.push(JSON.parse(e.data as string));
    } catch {
      messages.push(e.data);
    }
  });
  return messages;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// `getAgentByName` resolves to the same DurableObjectStub the rest of this
// suite uses for RPC. `evictDurableObject` requires a stub that points at a DO
// defined in the test worker's `main`, which TestChatAgent is.
function stubFor(room: string) {
  return getAgentByName(env.TestChatAgent, room);
}

describe("AIChatAgent eviction (evictDurableObject)", () => {
  describe("message history rehydration", () => {
    it("rebuilds the in-memory this.messages array from SQLite after eviction", async () => {
      const room = crypto.randomUUID();
      const agentStub = await stubFor(room);

      const userMessage: ChatMessage = {
        id: "evict-user-1",
        role: "user",
        parts: [{ type: "text", text: "remember me across eviction" }]
      };
      const assistantMessage: ChatMessage = {
        id: "evict-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "I will survive hibernation" }]
      };

      await agentStub.persistMessages([userMessage, assistantMessage]);

      // Sanity: the live instance has both the SQL rows and the in-memory copy.
      // The RPC stub return type for these synchronous ChatMessage[] methods
      // resolves to `never`, so cast as the rest of this suite does.
      const beforePersisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      const beforeInMemory =
        (await agentStub.getMessagesForTest()) as ChatMessage[];
      expect(beforePersisted.map((m) => m.id)).toEqual([
        "evict-user-1",
        "evict-assistant-1"
      ]);
      expect(beforeInMemory.map((m) => m.id)).toEqual([
        "evict-user-1",
        "evict-assistant-1"
      ]);

      // Evict: the instance is torn down, dropping the in-memory this.messages.
      await evictDurableObject(agentStub);

      // Re-access: the constructor re-runs and must rebuild this.messages from
      // cf_ai_chat_agent_messages. `getMessagesForTest()` returns the in-memory
      // array, NOT a fresh SQL read — so this fails if rehydration is broken.
      const afterInMemory =
        (await agentStub.getMessagesForTest()) as ChatMessage[];
      expect(afterInMemory.map((m) => m.id)).toEqual([
        "evict-user-1",
        "evict-assistant-1"
      ]);
      const surviving = afterInMemory.find((m) => m.id === "evict-assistant-1");
      expect(surviving).toBeDefined();
      const textPart = surviving!.parts.find((p) => p.type === "text") as
        | { text: string }
        | undefined;
      expect(textPart?.text).toBe("I will survive hibernation");

      // The /get-messages endpoint (SQL-backed) must agree with the rebuilt
      // in-memory view.
      const afterPersisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(afterPersisted.map((m) => m.id)).toEqual(
        afterInMemory.map((m) => m.id)
      );
    });

    it("rehydrates after evictAllDurableObjects()", async () => {
      const room = crypto.randomUUID();
      const agentStub = await stubFor(room);

      await agentStub.persistMessages([
        {
          id: "evict-all-1",
          role: "user",
          parts: [{ type: "text", text: "evict everything" }]
        }
      ]);

      await evictAllDurableObjects();

      const afterInMemory =
        (await agentStub.getMessagesForTest()) as ChatMessage[];
      expect(afterInMemory.map((m) => m.id)).toEqual(["evict-all-1"]);
    });
  });

  describe("resumable stream rehydration", () => {
    it("restores active stream id, request id and stored chunks after eviction", async () => {
      const room = crypto.randomUUID();
      const agentStub = await stubFor(room);

      const streamId = await agentStub.testStartStream("req-evict-resume");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"Hello"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":" world"}'
      );
      await agentStub.testFlushChunkBuffer();

      // Live instance: stream is active and tracked in memory.
      expect(await agentStub.getActiveStreamId()).toBe(streamId);
      expect(await agentStub.getActiveRequestId()).toBe("req-evict-resume");

      // Real eviction tears the ResumableStream instance down entirely.
      await evictDurableObject(agentStub);

      // The constructor builds a fresh ResumableStream whose restore() reads the
      // active stream back from cf_ai_chat_stream_metadata. `_activeStreamId`
      // delegates to that in-memory instance, so these assertions prove the
      // active-stream pointer was rebuilt, not just persisted.
      expect(await agentStub.getActiveStreamId()).toBe(streamId);
      expect(await agentStub.getActiveRequestId()).toBe("req-evict-resume");

      // Persisted chunks must be replayable after eviction.
      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(2);
      expect(chunks[0].body).toBe('{"type":"text","text":"Hello"}');
      expect(chunks[1].body).toBe('{"type":"text","text":" world"}');
    });

    it("completed streams stay completed and inactive after eviction", async () => {
      const room = crypto.randomUUID();
      const agentStub = await stubFor(room);

      const streamId = await agentStub.testStartStream("req-evict-complete");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"done"}'
      );
      await agentStub.testFlushChunkBuffer();
      await agentStub.testCompleteStream(streamId);

      expect(await agentStub.getActiveStreamId()).toBeNull();

      await evictDurableObject(agentStub);

      // restore() must NOT resurrect a completed stream as active.
      expect(await agentStub.getActiveStreamId()).toBeNull();
      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata?.status).toBe("completed");
      // Chunks are still readable for replay even though the stream is inactive.
      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(1);
    });
  });

  describe("WebSocket hibernation", () => {
    it("notifies a reconnecting client of a resumable stream after real eviction", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await stubFor(room);
      // Build an in-flight (orphaned) stream with persisted partial content.
      const streamId = await agentStub.testStartStream("req-evict-ws");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"partial after eviction"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Real eviction (default: hibernate WebSockets) instead of the in-process
      // testSimulateHibernationWake hook. The active stream must be restored
      // from SQLite by the rebuilt ResumableStream.
      await evictDurableObject(agentStub);
      expect(await agentStub.getActiveStreamId()).toBe(streamId);

      // A fresh client connecting after eviction must be told the stream is
      // resumable, then receive the replayed partial content ending in done.
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await waitFor(() => messages2.some(isStreamResumingMessage));
      const resumeMsg = messages2.find(isStreamResumingMessage) as {
        id: string;
      };
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: resumeMsg.id
        })
      );

      await waitFor(() =>
        messages2.some(
          (m) =>
            isUseChatResponseMessage(m) &&
            (m as { done?: boolean }).done === true
        )
      );

      const responseMessages = messages2.filter(isUseChatResponseMessage);
      const lastMsg = responseMessages[responseMessages.length - 1] as {
        replay?: boolean;
        done?: boolean;
      };
      expect(lastMsg.replay).toBe(true);
      expect(lastMsg.done).toBe(true);

      // The orphaned stream's partial content must have been persisted as an
      // assistant message during the wake/replay flow.
      const persisted = (await agentStub.getPersistedMessages()) as Array<{
        role: string;
        parts: Array<{ type: string; text?: string }>;
      }>;
      const assistantMsg = persisted.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      const textPart = assistantMsg!.parts.find((p) => p.type === "text");
      expect(textPart?.text).toContain("partial after eviction");
      expect(await agentStub.getActiveStreamId()).toBeNull();

      ws2.close(1000);
    });

    it('closes live WebSockets when evicting with { webSockets: "close" }', async () => {
      const room = crypto.randomUUID();

      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));
      // Precondition: the socket is genuinely open before we evict-and-close it,
      // so the post-eviction state change below is meaningful and not vacuous.
      expect(ws.readyState).toBe(WebSocket.OPEN);

      let sawClose = false;
      ws.addEventListener("close", () => {
        sawClose = true;
      });

      const agentStub = await stubFor(room);

      // With webSockets: "close" the eviction closes the open socket instead of
      // hibernating it — the client observes a close event.
      await evictDurableObject(agentStub, { webSockets: "close" });

      // The close should propagate to the client. Wait for either the close
      // event or the readyState leaving OPEN.
      await waitFor(() => sawClose || ws.readyState !== WebSocket.OPEN, 3000);
      expect(sawClose).toBe(true);
      expect(ws.readyState).not.toBe(WebSocket.OPEN);

      // The DO itself still rehydrates and serves RPC after the close-eviction.
      await agentStub.persistMessages([
        {
          id: "post-close-evict",
          role: "user",
          parts: [{ type: "text", text: "still alive" }]
        }
      ]);
      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.some((m) => m.id === "post-close-evict")).toBe(true);
    });
  });

  describe("scheduled alarm survival", () => {
    it("keeps the stream-cleanup alarm scheduled across eviction", async () => {
      const room = crypto.randomUUID();
      const agentStub = await stubFor(room);

      // Arm the cleanup alarm (persisted into cf_agents_schedules).
      await agentStub.testArmStreamCleanup();
      const delayBefore =
        await agentStub.testStreamCleanupScheduleDelaySeconds();
      expect(delayBefore).not.toBeNull();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      // Eviction drops in-memory state; the schedule lives in SQLite and must
      // still be visible (and re-readable) after the DO is rebuilt.
      await evictDurableObject(agentStub);

      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);
      const delayAfter =
        await agentStub.testStreamCleanupScheduleDelaySeconds();
      expect(delayAfter).not.toBeNull();
      // Same configured interval — a regression that drops/re-arms with a
      // different window would change this.
      expect(delayAfter).toBe(delayBefore);
    });
  });
});
