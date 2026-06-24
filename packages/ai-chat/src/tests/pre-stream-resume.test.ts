import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { getAgentByName } from "agents";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS } from "./test-utils";

/**
 * Integration coverage for the pre-stream resume window (#1784): a turn is
 * accepted (`_preStream.begin`) but its resumable stream has not started yet
 * (here, `SlowStreamAgent`'s `responseDelayMs` holds `onChatMessage` before it
 * returns a response). A client that connects or sends a resume request in that
 * window must be told to KEEP WAITING (`STREAM_PENDING`) rather than "nothing to
 * resume" (`STREAM_RESUME_NONE`), then flushed into `STREAM_RESUMING` once the
 * stream actually starts.
 *
 * Runs inside the Workers runtime against the real `AIChatAgent` so the whole
 * server path (chat-request accept → begin → onConnect/handleResumeRequest park
 * → _startStream flush) is exercised end to end.
 */

function hasType(m: unknown, type: string): boolean {
  return typeof m === "object" && m !== null && "type" in m && m.type === type;
}

function collectMessages(ws: WebSocket): OutgoingMessage[] {
  const messages: OutgoingMessage[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    try {
      messages.push(JSON.parse(e.data as string) as OutgoingMessage);
    } catch {
      // ignore non-JSON
    }
  });
  return messages;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
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
        body: JSON.stringify({
          messages: [
            {
              id: "u1",
              role: "user",
              parts: [{ type: "text", text: "hi" }]
            }
          ],
          ...extraBody
        })
      }
    })
  );
}

describe("Pre-stream resume window (#1784)", () => {
  it("onConnect during the pre-stream window parks the client with STREAM_PENDING, then STREAM_RESUMING when the stream starts", async () => {
    const room = crypto.randomUUID();
    const { ws: ws1 } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    // Accept a turn whose stream is delayed ~1s — the pre-stream window.
    const requestId = "req-pre-stream-connect";
    sendChatRequest(ws1, requestId, {
      responseDelayMs: 1000,
      chunkCount: 1,
      chunkDelayMs: 10
    });

    // Barrier: onChatMessage has entered (pushes the id) and is now delaying,
    // so the turn is accepted but no stream exists yet.
    await waitFor(async () => {
      const started = (await agentStub.getStartedRequestIds()) as string[];
      return started.includes(requestId);
    });

    // A NEW connection joins mid pre-stream window.
    const { ws: ws2 } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const messages2 = collectMessages(ws2);

    // It should be told to keep waiting (STREAM_PENDING), never "nothing".
    await waitFor(() =>
      messages2.some((m) => hasType(m, MessageType.CF_AGENT_STREAM_PENDING))
    );
    expect(
      messages2.some((m) => hasType(m, MessageType.CF_AGENT_STREAM_RESUME_NONE))
    ).toBe(false);

    // Once the delay elapses and the stream starts, the parked connection is
    // flushed into the normal resume handshake.
    await waitFor(
      () =>
        messages2.some((m) => hasType(m, MessageType.CF_AGENT_STREAM_RESUMING)),
      4000
    );

    ws1.close(1000);
    ws2.close(1000);
  });

  it("a resume request during the pre-stream window gets STREAM_PENDING (not RESUME_NONE)", async () => {
    const room = crypto.randomUUID();
    const { ws: ws1 } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    const requestId = "req-pre-stream-request";
    sendChatRequest(ws1, requestId, {
      responseDelayMs: 1000,
      chunkCount: 1,
      chunkDelayMs: 10
    });

    await waitFor(async () => {
      const started = (await agentStub.getStartedRequestIds()) as string[];
      return started.includes(requestId);
    });

    const { ws: ws2 } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const messages2 = collectMessages(ws2);
    await new Promise((r) => setTimeout(r, 30));

    ws2.send(
      JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST })
    );

    await waitFor(() =>
      messages2.some((m) => hasType(m, MessageType.CF_AGENT_STREAM_PENDING))
    );
    expect(
      messages2.some((m) => hasType(m, MessageType.CF_AGENT_STREAM_RESUME_NONE))
    ).toBe(false);

    ws1.close(1000);
    ws2.close(1000);
  });

  it("keeps a client parked across overlapping submits until a turn streams, never cutting it loose early (#1784)", async () => {
    const room = crypto.randomUUID();
    const { ws: ws1 } = await connectChatWS(
      `/agents/latest-message-concurrency-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(
      env.LatestMessageConcurrencyAgent,
      room
    );

    // First submit is accepted and delays in the pre-stream window.
    const firstId = "req-first";
    sendChatRequest(ws1, firstId, {
      responseDelayMs: 1000,
      chunkCount: 1,
      chunkDelayMs: 10
    });
    await waitFor(async () => {
      const started = (await agentStub.getStartedRequestIds()) as string[];
      return started.includes(firstId);
    });

    // A client connects and parks while a turn is in flight pre-stream.
    const { ws: ws2 } = await connectChatWS(
      `/agents/latest-message-concurrency-agent/${room}`
    );
    const messages2 = collectMessages(ws2);
    await waitFor(() =>
      messages2.some((m) => hasType(m, MessageType.CF_AGENT_STREAM_PENDING))
    );

    // A second overlapping submit lands while the first is still pre-stream.
    // Whatever the concurrency policy decides, the parked client must resume
    // onto whichever turn actually streams — it must NOT receive a premature
    // STREAM_RESUME_NONE while a turn is still in flight (the supersede/settle
    // race the `releaseParked: false` skip-path guard closes).
    sendChatRequest(ws1, "req-second", {
      responseDelayMs: 10,
      chunkCount: 1,
      chunkDelayMs: 10
    });

    await waitFor(
      () =>
        messages2.some((m) => hasType(m, MessageType.CF_AGENT_STREAM_RESUMING)),
      4000
    );

    // The parked client went straight from PENDING to RESUMING: no spurious
    // "nothing to resume" was emitted while turns were still in flight.
    const firstResuming = messages2.findIndex((m) =>
      hasType(m, MessageType.CF_AGENT_STREAM_RESUMING)
    );
    const resumeNoneBeforeResuming = messages2
      .slice(0, firstResuming)
      .some((m) => hasType(m, MessageType.CF_AGENT_STREAM_RESUME_NONE));
    expect(resumeNoneBeforeResuming).toBe(false);

    ws1.close(1000);
    ws2.close(1000);
  });
});
