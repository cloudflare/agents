/**
 * The terminal `done` frame must follow the transcript broadcast.
 *
 * `useAgentChat` flips to `ready` on `done`. If the persisted transcript
 * (`cf_agent_chat_messages`) arrives after that, it replaces the client's
 * message list and drops any message the user sent in between. The sending
 * connection is excluded from the broadcast for its own turn, so these tests
 * watch from a second connection and from programmatic turns.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

type Frame =
  | { kind: "messages"; messages: UIMessage[] }
  | { kind: "error" }
  | { kind: "done"; error: boolean };

/**
 * Records transcript and terminal frames, in order, until `done`. An in-band
 * stream error arrives as an `error` frame before `done`; clients treat it as
 * terminal too.
 */
function recordUntilDone(ws: WebSocket, timeout = 10_000): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as Record<string, unknown>;
      if (data.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
        frames.push({
          kind: "messages",
          messages: data.messages as UIMessage[]
        });
      } else if (isUseChatResponseMessage(data) && data.error && !data.done) {
        frames.push({ kind: "error" });
      } else if (isUseChatResponseMessage(data) && data.done) {
        frames.push({ kind: "done", error: data.error === true });
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(frames);
      }
    };
    ws.addEventListener("message", handler);
  });
}

/** Lets the connect-time frames arrive before recording starts. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

function expectAssistantTranscriptBeforeDone(frames: Frame[]) {
  const doneIndex = frames.findIndex((frame) => frame.kind === "done");
  const transcriptIndex = frames.findIndex(
    (frame) =>
      frame.kind === "messages" &&
      frame.messages.at(-1)?.role === "assistant" &&
      frame.messages.at(-1)!.parts.length > 0
  );
  expect(transcriptIndex).toBeGreaterThanOrEqual(0);
  expect(transcriptIndex).toBeLessThan(doneIndex);
  expect(doneIndex).toBe(frames.length - 1);
}

/** Bodies of the replay frames `ws` receives for `requestId`. */
function collectReplayBodies(ws: WebSocket, requestId: string): string[] {
  const bodies: string[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    const data = JSON.parse(e.data as string) as Record<string, unknown>;
    if (
      isUseChatResponseMessage(data) &&
      data.id === requestId &&
      data.replay &&
      typeof data.body === "string" &&
      data.body
    ) {
      bodies.push(data.body);
    }
  });
  return bodies;
}

function sendChat(ws: WebSocket, body: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "hello" }]
            }
          ],
          ...body
        })
      }
    })
  );
  return id;
}

describe("AIChatAgent — terminal frame ordering", () => {
  it.each(["sse", "plaintext"])(
    "broadcasts the transcript before done to other tabs (%s)",
    async (format) => {
      const room = crypto.randomUUID();
      const { ws: sender } = await connectChatWS(
        `/agents/response-agent/${room}`
      );
      const { ws: observer } = await connectChatWS(
        `/agents/response-agent/${room}`
      );
      await settle();

      const frames = recordUntilDone(observer);
      sendChat(sender, { format });

      const recorded = await frames;
      expectAssistantTranscriptBeforeDone(recorded);
      expect(recorded.at(-1)).toEqual({ kind: "done", error: false });
      sender.close(1000);
      observer.close(1000);
    }
  );

  it("broadcasts the persisted partial before the error frame when the stream throws", async () => {
    const room = crypto.randomUUID();
    const { ws: sender } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    const { ws: observer } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    await settle();

    const frames = recordUntilDone(observer);
    sendChat(sender, { format: "plaintext", chunkCount: 4, throwError: true });

    const recorded = await frames;
    expectAssistantTranscriptBeforeDone(recorded);
    expect(recorded.at(-1)).toEqual({ kind: "done", error: true });
    sender.close(1000);
    observer.close(1000);
  });

  it("broadcasts the persisted partial before an in-band SSE error frame", async () => {
    const room = crypto.randomUUID();
    const { ws: sender } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    const { ws: observer } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    await settle();

    const frames = recordUntilDone(observer);
    sendChat(sender, {
      format: "sse",
      streamError: "quota exceeded",
      streamErrorAfterText: true
    });

    const recorded = await frames;
    const errorIndex = recorded.findIndex((frame) => frame.kind === "error");
    const transcriptIndex = recorded.findIndex(
      (frame) =>
        frame.kind === "messages" &&
        frame.messages.at(-1)?.role === "assistant" &&
        frame.messages.at(-1)!.parts.length > 0
    );
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(transcriptIndex).toBeGreaterThanOrEqual(0);
    expect(transcriptIndex).toBeLessThan(errorIndex);
    expect(recorded.slice(errorIndex).map((frame) => frame.kind)).toEqual([
      "error",
      "done"
    ]);
    sender.close(1000);
    observer.close(1000);
  });

  it("turns the held done frame into an error when persistence fails", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/response-agent/${room}`);
    await settle();
    const agent = await getAgentByName(env.ResponseAgent, room);
    await agent.failNextAssistantPersist();

    const outcomes: unknown[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as Record<string, unknown>;
      if (isUseChatResponseMessage(data) && data.done) {
        outcomes.push(data.outcome);
      }
    });
    const frames = recordUntilDone(ws);
    sendChat(ws, { format: "sse" });

    const recorded = await frames;
    expect(recorded.at(-1)).toEqual({ kind: "done", error: true });
    expect(outcomes).toEqual(["error"]);
    ws.close(1000);
  });

  it("holds a resume ACK that lands while the response is being persisted", async () => {
    const room = crypto.randomUUID();
    const { ws: sender } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    await settle();
    const agent = await getAgentByName(env.ResponseAgent, room);
    await agent.blockNextAssistantPersist();

    const requestId = sendChat(sender, { format: "sse" });
    for (
      let i = 0;
      i < 100 && !(await agent.isAssistantPersistBlocked());
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await agent.isAssistantPersistBlocked()).toBe(true);

    const { ws: reconnected } = await connectChatWS(
      `/agents/response-agent/${room}`
    );
    await settle();
    const frames = recordUntilDone(reconnected);
    const replayed = collectReplayBodies(reconnected, requestId);
    reconnected.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: requestId
      })
    );
    await settle();
    expect(replayed.some((body) => body.includes("chunk-0"))).toBe(true);
    await agent.releaseAssistantPersist();

    const recorded = await frames;
    expectAssistantTranscriptBeforeDone(recorded);
    expect(recorded.at(-1)).toEqual({ kind: "done", error: false });
    sender.close(1000);
    reconnected.close(1000);
  });

  it("replays a recovering stream's partial to an ACK that lands while it is persisted", async () => {
    const room = crypto.randomUUID();
    const agent = (await getAgentByName(
      env.ChatRecoveryTestAgent,
      room
    )) as unknown as {
      armStallingTurnsForTest(timeoutMs: number, hangTurns: number): void;
      blockNextAssistantPersistForTest(): void;
      isAssistantPersistBlockedForTest(): boolean;
      releaseAssistantPersistForTest(): void;
    };
    await agent.armStallingTurnsForTest(150, 1);
    await agent.blockNextAssistantPersistForTest();
    const { ws: sender } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    await settle();

    const requestId = sendChat(sender, {});
    for (
      let i = 0;
      i < 100 && !(await agent.isAssistantPersistBlockedForTest());
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await agent.isAssistantPersistBlockedForTest()).toBe(true);

    const { ws: reconnected } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    await settle();
    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for done")),
        10_000
      );
      reconnected.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        if (
          isUseChatResponseMessage(data) &&
          data.id === requestId &&
          data.done
        ) {
          clearTimeout(timer);
          resolve(data);
        }
      });
    });
    const replayed = collectReplayBodies(reconnected, requestId);
    reconnected.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: requestId
      })
    );
    await settle();
    expect(replayed.some((body) => body.includes("partial before stall"))).toBe(
      true
    );
    await agent.releaseAssistantPersistForTest();

    expect(await done).toMatchObject({ outcome: "recovering" });
    sender.close(1000);
    reconnected.close(1000);
  });

  it("settles the originating tab when onChatMessage returns no response", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/response-agent/${room}`);
    await settle();

    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for done")),
        5000
      );
      ws.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        if (isUseChatResponseMessage(data) && data.done) {
          clearTimeout(timer);
          resolve(data);
        }
      });
    });
    const requestId = sendChat(ws, { noResponse: true });

    expect(await done).toMatchObject({
      id: requestId,
      done: true,
      outcome: "completed"
    });
    ws.close(1000);
  });

  it("broadcasts the transcript before done on a programmatic turn", async () => {
    const room = crypto.randomUUID();
    const { ws: observer } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    await settle();
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    const frames = recordUntilDone(observer);
    const result = await agent.enqueueSyntheticUserMessage("hello", {
      body: { format: "sse", chunkCount: 3, chunkDelayMs: 5 }
    });

    expect(result.status).toBe("completed");
    const recorded = await frames;
    expectAssistantTranscriptBeforeDone(recorded);
    expect(recorded.at(-1)).toEqual({ kind: "done", error: false });
    observer.close(1000);
  });
});
