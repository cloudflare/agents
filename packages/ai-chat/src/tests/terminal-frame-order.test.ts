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
  | { kind: "done"; error: boolean };

/** Records transcript and terminal frames, in order, until `done`. */
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

function sendChat(ws: WebSocket, body: Record<string, unknown>) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: crypto.randomUUID(),
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

  it("turns the held done frame into an error when persistence fails", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/response-agent/${room}`);
    await settle();
    const agent = await getAgentByName(env.ResponseAgent, room);
    await agent.failNextAssistantPersist();

    const frames = recordUntilDone(ws);
    sendChat(ws, { format: "sse" });

    const recorded = await frames;
    expect(recorded.at(-1)).toEqual({ kind: "done", error: true });
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
