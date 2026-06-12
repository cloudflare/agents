import { env } from "cloudflare:workers";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ChatResponseResult } from "../";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

/**
 * #1575 acceptance tests: a client reconnecting after an in-band stream error
 * must observe the same terminal outcome a live client did — the partial
 * content the model produced before the error, followed by a terminal
 * `done: true, error: true` frame. Chunk replay is the only channel for that
 * partial content: the server does not push messages on connect, so a client
 * that missed the live broadcasts has nothing else to recover from.
 */

const userMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

function sendChatRequest(
  ws: WebSocket,
  requestId: string,
  extraBody: Record<string, unknown>
) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [userMessage], ...extraBody })
      }
    })
  );
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

type Frame = Record<string, unknown>;

function collectFrames(ws: WebSocket): Frame[] {
  const frames: Frame[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    try {
      frames.push(JSON.parse(e.data as string) as Frame);
    } catch {
      // ignore non-JSON frames
    }
  });
  return frames;
}

/** Extract text-delta deltas from chat-response frames, in arrival order. */
function textDeltas(frames: Frame[], opts: { replayOnly: boolean }): string[] {
  return frames
    .filter(
      (f) =>
        f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        f.error !== true &&
        typeof f.body === "string" &&
        f.body.length > 0 &&
        (!opts.replayOnly || f.replay === true)
    )
    .map((f) => {
      try {
        return JSON.parse(f.body as string) as {
          type?: string;
          delta?: string;
        };
      } catch {
        return {};
      }
    })
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta as string);
}

/**
 * Run the real WebSocketChatTransport reconnect handshake: send
 * RESUME_REQUEST, ACK the STREAM_RESUMING offer, and collect everything the
 * server sends until a terminal `done: true` frame (or RESUME_NONE) arrives.
 */
async function reconnectAndCollect(path: string): Promise<Frame[]> {
  const { ws } = await connectChatWS(path);
  const frames = collectFrames(ws);
  ws.addEventListener("message", (e: MessageEvent) => {
    try {
      const frame = JSON.parse(e.data as string) as Frame;
      if (frame.type === MessageType.CF_AGENT_STREAM_RESUMING) {
        ws.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: frame.id
          })
        );
      }
    } catch {
      // ignore
    }
  });
  ws.send(JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST }));
  await waitFor(() =>
    frames.some(
      (f) =>
        (f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          f.done === true) ||
        f.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
    )
  );
  ws.close(1000);
  return frames;
}

describe("Errored stream replay (#1575)", () => {
  it("replays pre-error partial content and the terminal error to a reconnecting client", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/slow-stream-agent/${room}`;

    // Live client drives a turn that streams 3 text chunks, then dies with an
    // in-band error.
    const { ws: liveWs } = await connectChatWS(path);
    const liveFrames = collectFrames(liveWs);
    sendChatRequest(liveWs, "req-err-partial", {
      format: "sse",
      streamError: "in-band boom",
      errorAfterChunks: 3,
      chunkDelayMs: 10
    });
    await waitFor(() =>
      liveFrames.some(
        (f) =>
          f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && f.done === true
      )
    );

    // What the live observer saw: the partial content, then the error.
    expect(textDeltas(liveFrames, { replayOnly: false })).toEqual([
      "partial-0 ",
      "partial-1 ",
      "partial-2 "
    ]);
    const liveError = liveFrames.find((f) => f.error === true);
    expect(liveError?.body).toBe("in-band boom");
    liveWs.close(1000);

    // Wait for the turn to fully drain (the durable terminal record is
    // written just before onChatResponse fires).
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);
    await waitFor(
      async () =>
        ((await agentStub.getChatResponseResults()) as ChatResponseResult[])
          .length === 1
    );

    // A fresh client — it observed none of the live frames — reconnects.
    const frames = await reconnectAndCollect(path);

    // It must observe the SAME outcome: the partial content (as replay
    // frames), then a terminal done+error frame with the same error text.
    expect(textDeltas(frames, { replayOnly: true })).toEqual([
      "partial-0 ",
      "partial-1 ",
      "partial-2 "
    ]);
    const terminal = frames.find(
      (f) =>
        f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        f.error === true &&
        f.done === true
    );
    expect(terminal?.body).toBe("in-band boom");

    // The terminal frame arrives after all replayed content.
    const chatFrames = frames.filter(
      (f) => f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE
    );
    expect(chatFrames[chatFrames.length - 1]).toBe(terminal);
  });

  it("delivers only the terminal error when the error preceded any content", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/slow-stream-agent/${room}`;

    // The early in-band error case (#1527): error is the very first chunk.
    const { ws: liveWs } = await connectChatWS(path);
    const liveFrames = collectFrames(liveWs);
    sendChatRequest(liveWs, "req-err-early", {
      format: "sse",
      streamError: "early in-band boom"
    });
    await waitFor(() =>
      liveFrames.some(
        (f) =>
          f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && f.done === true
      )
    );
    liveWs.close(1000);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);
    await waitFor(
      async () =>
        ((await agentStub.getChatResponseResults()) as ChatResponseResult[])
          .length === 1
    );

    const frames = await reconnectAndCollect(path);

    // No content existed before the error, so nothing is replayed — just the
    // terminal error frame.
    expect(textDeltas(frames, { replayOnly: true })).toEqual([]);
    const terminal = frames.find(
      (f) =>
        f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        f.error === true &&
        f.done === true
    );
    expect(terminal?.body).toBe("early in-band boom");
  });

  it("returns the documented contract from replayErroredChunksByRequestId (#1575)", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/slow-stream-agent/${room}`;

    // Produce a real errored stream with buffered partial content.
    const { ws } = await connectChatWS(path);
    const frames = collectFrames(ws);
    sendChatRequest(ws, "req-drop", {
      format: "sse",
      streamError: "boom",
      errorAfterChunks: 3,
      chunkDelayMs: 10
    });
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && f.done === true
      )
    );
    ws.close(1000);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);
    await waitFor(
      async () =>
        ((await agentStub.getChatResponseResults()) as ChatResponseResult[])
          .length === 1
    );

    // No errored stream for the request → nothing to replay, but the caller
    // should still proceed to send its terminal frame (returns true, sent 0).
    expect(
      await agentStub.replayErroredChunksByRequestIdForTest("no-such-req", 999)
    ).toEqual({ returned: true, sent: 0 });

    // All buffered chunks replay successfully → returns true.
    const full = await agentStub.replayErroredChunksByRequestIdForTest(
      "req-drop",
      999
    );
    expect(full.returned).toBe(true);
    expect(full.sent).toBeGreaterThan(1);

    // Connection drops mid-replay → returns false and stops early, so the
    // caller skips the terminal frame and the next reconnect retries.
    const dropped = await agentStub.replayErroredChunksByRequestIdForTest(
      "req-drop",
      1
    );
    expect(dropped).toEqual({ returned: false, sent: 1 });
  });
});
