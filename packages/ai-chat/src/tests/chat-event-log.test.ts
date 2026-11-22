/**
 * Chat frames ride the `cf_chat` event log. A tab that follows the log and
 * comes back after being away gets every frame it missed by cursor,
 * terminal frames included, for every request that ran meanwhile, not
 * only one. A tab that does not follow the log gets frames the old way.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

type Frame = Record<string, unknown> & { type: string };

function record(ws: WebSocket): Frame[] {
  const frames: Frame[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    frames.push(JSON.parse(event.data as string) as Frame);
  });
  return frames;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function sendChat(ws: WebSocket): string {
  const id = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({
          format: "plaintext",
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "hello" }]
            }
          ]
        })
      }
    })
  );
  return id;
}

type ChatEvent = { frame: Frame; without?: string[] };

/** The chat frames a log follower got, unwrapped, in log order. */
function logFrames(frames: Frame[]): Frame[] {
  return frames
    .filter((frame) => frame.type === "cf_agent_log_events")
    .flatMap((frame) =>
      (frame.events as Array<{ data: ChatEvent }>).map(
        (event) => event.data.frame
      )
    );
}

function isTerminal(frame: Frame, id: string): boolean {
  return (
    frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
    frame.id === id &&
    frame.done === true
  );
}

describe("AIChatAgent chat event log", () => {
  it("gives a tab that was away the terminal frame of every request that ran meanwhile", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/response-agent/${room}`;

    const { ws: away } = await connectChatWS(path);
    const awayFrames = record(away);
    away.send(
      JSON.stringify({ type: "cf_agent_log_subscribe", log: "cf_chat" })
    );
    await waitFor(() =>
      awayFrames.some((frame) => frame.type === "cf_agent_log_resync")
    );
    const resync = awayFrames.find(
      (frame) => frame.type === "cf_agent_log_resync"
    )!;
    away.close(1000);

    const { ws: sender } = await connectChatWS(path);
    const senderFrames = record(sender);
    const first = sendChat(sender);
    await waitFor(() => senderFrames.some((frame) => isTerminal(frame, first)));
    const second = sendChat(sender);
    await waitFor(() =>
      senderFrames.some((frame) => isTerminal(frame, second))
    );

    const { ws: back } = await connectChatWS(path);
    const backFrames = record(back);
    back.send(
      JSON.stringify({
        type: "cf_agent_log_subscribe",
        log: "cf_chat",
        cursor: { epoch: resync.epoch, seq: resync.seq }
      })
    );
    await waitFor(() =>
      backFrames.some((frame) => frame.type === "cf_agent_log_synced")
    );
    const replayed = logFrames(backFrames);
    expect(replayed.some((frame) => isTerminal(frame, first))).toBe(true);
    expect(replayed.some((frame) => isTerminal(frame, second))).toBe(true);
    // Chunks come before their request's terminal frame.
    const firstChunk = replayed.findIndex(
      (frame) =>
        frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        frame.id === first &&
        frame.done === false
    );
    expect(firstChunk).toBeGreaterThanOrEqual(0);
    expect(firstChunk).toBeLessThan(
      replayed.findIndex((frame) => isTerminal(frame, first))
    );
    sender.close(1000);
    back.close(1000);
  });

  it("sends a follower its frames from the log only, and others the old way", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/response-agent/${room}`;
    const { ws: follower } = await connectChatWS(path);
    const followerFrames = record(follower);
    follower.send(
      JSON.stringify({ type: "cf_agent_log_subscribe", log: "cf_chat" })
    );
    await waitFor(() =>
      followerFrames.some((frame) => frame.type === "cf_agent_log_resync")
    );
    const { ws: legacy } = await connectChatWS(path);
    const legacyFrames = record(legacy);
    const { ws: sender } = await connectChatWS(path);

    const id = sendChat(sender);
    await waitFor(() => legacyFrames.some((frame) => isTerminal(frame, id)));
    await waitFor(() =>
      logFrames(followerFrames).some((frame) => isTerminal(frame, id))
    );

    // The follower got no raw copy of a frame the log carries.
    expect(
      followerFrames.some(
        (frame) =>
          frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          frame.id === id
      )
    ).toBe(false);
    // The tab that does not follow gets the frames, marked as in the log.
    const raw = legacyFrames.find((frame) => isTerminal(frame, id))!;
    expect(raw.inLog).toBe(true);
    follower.close(1000);
    legacy.close(1000);
    sender.close(1000);
  });

  it("resyncs a new follower mid-reply from the stored chunks so far", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/response-agent/${room}`;
    const { ws: sender } = await connectChatWS(path);
    const senderFrames = record(sender);
    const id = sendChat(sender);
    await waitFor(() =>
      senderFrames.some(
        (frame) =>
          frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          frame.id === id
      )
    );
    const { ws: late } = await connectChatWS(path);
    const lateFrames = record(late);
    late.send(
      JSON.stringify({ type: "cf_agent_log_subscribe", log: "cf_chat" })
    );
    await waitFor(() =>
      lateFrames.some((frame) => frame.type === "cf_agent_log_resync")
    );
    const resync = lateFrames.find(
      (frame) => frame.type === "cf_agent_log_resync"
    )!;
    const snapshot = resync.snapshot as {
      messages: unknown[];
      active?: { requestId: string; chunks: string[] };
    };
    expect(Array.isArray(snapshot.messages)).toBe(true);
    // Either the reply is still streaming (and the snapshot carries it) or
    // it already finished (and the transcript holds it).
    if (snapshot.active) {
      expect(snapshot.active.requestId).toBe(id);
      expect(snapshot.active.chunks.length).toBeGreaterThan(0);
    }
    await waitFor(() => senderFrames.some((frame) => isTerminal(frame, id)));
    sender.close(1000);
    late.close(1000);
  });

  it("ends an orphaned stream a follower acks with one aborted terminal in the log, and stores its partial", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/test-chat-agent/${room}`;
    const agent = await getAgentByName(env.TestChatAgent, room);
    const streamId = await agent.testStartStream("req-orphan-log");
    await agent.testStoreStreamChunk(
      streamId,
      '{"type":"text-start","id":"t1"}'
    );
    await agent.testStoreStreamChunk(
      streamId,
      '{"type":"text-delta","id":"t1","delta":"partial"}'
    );
    await agent.testFlushChunkBuffer();
    await agent.testSimulateHibernationWake();

    const { ws } = await connectChatWS(path);
    const frames = record(ws);
    ws.send(JSON.stringify({ type: "cf_agent_log_subscribe", log: "cf_chat" }));
    await waitFor(() =>
      frames.some((frame) => frame.type === "cf_agent_log_resync")
    );
    const resync = frames.find(
      (frame) => frame.type === "cf_agent_log_resync"
    )!;
    expect(
      (resync.snapshot as { active?: { requestId: string } }).active?.requestId
    ).toBe("req-orphan-log");

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: "req-orphan-log"
      })
    );
    await waitFor(() =>
      logFrames(frames).some((frame) => isTerminal(frame, "req-orphan-log"))
    );
    const terminal = logFrames(frames).find((frame) =>
      isTerminal(frame, "req-orphan-log")
    )!;
    expect(terminal.outcome).toBe("aborted");
    // No raw replay: the follower replays from the log itself.
    expect(
      frames.some(
        (frame) =>
          frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          frame.replay === true
      )
    ).toBe(false);
    expect(await agent.getActiveStreamId()).toBeNull();
    const persisted = (await agent.getPersistedMessages()) as unknown as Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>;
    expect(
      persisted.some(
        (message) =>
          message.role === "assistant" &&
          message.parts.some((part) => part.text?.includes("partial"))
      )
    ).toBe(true);
    ws.close(1000);
  });

  it("answers a follower's resume request after its turn ended with idle", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/response-agent/${room}`;
    const { ws } = await connectChatWS(path);
    const frames = record(ws);
    ws.send(JSON.stringify({ type: "cf_agent_log_subscribe", log: "cf_chat" }));
    await waitFor(() =>
      frames.some((frame) => frame.type === "cf_agent_log_resync")
    );
    const id = sendChat(ws);
    await waitFor(() =>
      logFrames(frames).some((frame) => isTerminal(frame, id))
    );
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
        probeId: "p1"
      })
    );
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
      )
    );
    expect(
      frames.find(
        (frame) => frame.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
      )
    ).toMatchObject({ reason: "idle", probeId: "p1" });
    expect(
      frames.some(
        (frame) =>
          frame.type === MessageType.CF_AGENT_STREAM_RESUMING ||
          (frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
            frame.id === id)
      )
    ).toBe(false);
    ws.close(1000);
  });

  it("clears the log with the chat: a follower resyncs to the empty transcript, and an old cursor replays nothing", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/response-agent/${room}`;
    const { ws } = await connectChatWS(path);
    const frames = record(ws);
    ws.send(JSON.stringify({ type: "cf_agent_log_subscribe", log: "cf_chat" }));
    await waitFor(() =>
      frames.some((frame) => frame.type === "cf_agent_log_resync")
    );
    const first = frames.find((frame) => frame.type === "cf_agent_log_resync")!;
    const id = sendChat(ws);
    await waitFor(() =>
      logFrames(frames).some((frame) => isTerminal(frame, id))
    );

    const { ws: clearer } = await connectChatWS(path);
    clearer.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await waitFor(
      () =>
        frames.filter((frame) => frame.type === "cf_agent_log_resync")
          .length === 2
    );
    const second = frames.filter(
      (frame) => frame.type === "cf_agent_log_resync"
    )[1];
    expect(second.epoch).not.toBe(first.epoch);
    expect((second.snapshot as { messages: unknown[] }).messages).toEqual([]);
    await waitFor(() =>
      logFrames(frames).some(
        (frame) => frame.type === MessageType.CF_AGENT_CHAT_CLEAR
      )
    );

    // A tab back with a cursor from before the clear gets no deleted frame.
    const { ws: back } = await connectChatWS(path);
    const backFrames = record(back);
    back.send(
      JSON.stringify({
        type: "cf_agent_log_subscribe",
        log: "cf_chat",
        cursor: { epoch: first.epoch, seq: first.seq }
      })
    );
    await waitFor(() =>
      backFrames.some((frame) => frame.type === "cf_agent_log_resync")
    );
    expect(
      logFrames(backFrames).some(
        (frame) => frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE
      )
    ).toBe(false);
    ws.close(1000);
    clearer.close(1000);
    back.close(1000);
  });
});
