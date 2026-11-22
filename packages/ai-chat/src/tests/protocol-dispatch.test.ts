import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

async function agentFor(room: string) {
  return getAgentByName(env.TestChatAgent, room);
}

/**
 * Send a message, then a plain-text probe the agent passes to `onMessage`.
 * A socket's messages are handled in order, so once the probe has arrived
 * the message before it has been handled.
 */
async function sendAndSettle(
  ws: WebSocket,
  room: string,
  message: Record<string, unknown>
) {
  const probe = `probe-${crypto.randomUUID()}`;
  ws.send(JSON.stringify(message));
  ws.send(probe);
  const agent = await agentFor(room);
  for (let i = 0; i < 200; i++) {
    if ((await agent.forwardedMessagesForTest()).includes(probe)) return probe;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the probe never reached onMessage");
}

describe("AIChatAgent chat protocol dispatch", () => {
  it("leaves only non-protocol messages to onMessage (D141)", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const probe = await sendAndSettle(ws, room, {
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: "not-a-post",
      init: { method: "GET" }
    });
    const agent = await agentFor(room);
    expect(await agent.forwardedMessagesForTest()).toEqual([probe]);
    ws.close();
  });

  it("reports a chat request with no messages array and runs no turn (D140)", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const events: Array<{ payload: { requestId?: string; stage?: string } }> =
      [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:request:failed") events.push(event);
    });
    const frames: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE) {
        frames.push(frame);
      }
    });
    try {
      await sendAndSettle(ws, room, {
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "no-messages",
        init: { method: "POST", body: JSON.stringify({ text: "hi" }) }
      });
    } finally {
      unsubscribe();
    }
    expect(
      events.map((event) => [event.payload.requestId, event.payload.stage])
    ).toEqual([["no-messages", "parse"]]);
    // The tab that sent it is told the request ended.
    for (let i = 0; i < 200 && frames.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(frames).toEqual([
      expect.objectContaining({ id: "no-messages", done: true, error: true })
    ]);
    const agent = await agentFor(room);
    expect(await agent.getChatMessageCallCountForTest()).toBe(0);
    ws.close();
  });

  it("replays a rejected request's terminal to a tab that resumes by its id (D140)", async () => {
    const room = crypto.randomUUID();
    const { ws: first } = await connectChatWS(
      `/agents/test-chat-agent/${room}`
    );
    await sendAndSettle(first, room, {
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: "rejected-away",
      init: { method: "POST", body: "{nope" }
    });
    first.close();

    // A new socket for the same tab, which never saw the frame.
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      seen.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
        probeId: "p1",
        requestIds: ["rejected-away"]
      })
    );
    const until = async (found: () => boolean, what: string) => {
      for (let i = 0; i < 200 && !found(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!found()) throw new Error(`timed out waiting for ${what}`);
    };
    await until(
      () =>
        seen.some(
          (m) =>
            m.type === MessageType.CF_AGENT_STREAM_RESUMING &&
            m.id === "rejected-away"
        ),
      "the resume offer"
    );
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: "rejected-away"
      })
    );
    await until(
      () =>
        seen.some(
          (m) =>
            m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
            m.id === "rejected-away" &&
            m.done === true
        ),
      "the replayed terminal"
    );
    expect(
      seen.find(
        (m) =>
          m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          m.id === "rejected-away" &&
          m.done === true
      )
    ).toMatchObject({ error: true });
    ws.close();
  });
});
