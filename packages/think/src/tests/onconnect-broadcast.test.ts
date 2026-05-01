import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { ThinkTestAgent } from "./agents/think-session";

// Covers the Think server's `onConnect` broadcast policy. The server must
// not send `cf_agent_chat_messages` while a resumable stream is in flight,
// because the client is about to rebuild the in-progress assistant message
// from the resume stream and a state broadcast here would clobber it.
// See the onConnect block in `packages/think/src/think.ts` for details.

const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_STREAM_RESUME_ACK = "cf_agent_stream_resume_ack";
const MSG_STREAM_RESUMING = "cf_agent_stream_resuming";

async function freshAgent(name?: string) {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name ?? crypto.randomUUID()
  );
}

async function connectWS(room: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

async function connectSubAgentWS(parentRoom: string, childRoom: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${parentRoom}/sub/think-test-agent/${childRoom}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function collectMessages(
  ws: WebSocket,
  timeout = 500
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string) as Record<string, unknown>);
      } catch {
        // ignore non-JSON frames
      }
      // Keep collecting until the timer fires; we want to observe
      // everything the server sends on connect, not race the first
      // frame.
      timer.refresh?.();
    });
  });
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

describe("Think — onConnect broadcast policy", () => {
  it("broadcasts CHAT_MESSAGES on connect when no stream is active", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(room);

    const messages = await collectMessages(ws);
    const types = messages.map((m) => m.type);

    expect(types).toContain(MSG_CHAT_MESSAGES);
    expect(types).not.toContain(MSG_STREAM_RESUMING);

    await closeWS(ws);
  });

  it("suppresses CHAT_MESSAGES on connect while a resumable stream is active", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);

    // Simulate an in-flight resumable stream. The resume flow will be
    // the authoritative path for delivering message state, so the
    // server must not also emit CHAT_MESSAGES here.
    const streamId = await agent.testStartResumableStream(
      "req-onconnect-active"
    );

    const { ws } = await connectWS(room);
    const messages = await collectMessages(ws);
    const types = messages.map((m) => m.type);

    expect(types).toContain(MSG_STREAM_RESUMING);
    expect(types).not.toContain(MSG_CHAT_MESSAGES);

    await closeWS(ws);
    await agent.testCompleteResumableStream(streamId);
  });

  it("does not send parent resume protocol on a sub-agent WebSocket", async () => {
    const parentRoom = crypto.randomUUID();
    const childRoom = crypto.randomUUID();
    const parent = await freshAgent(parentRoom);

    const streamId = await parent.testStartResumableStream("req-parent-active");

    const { ws } = await connectSubAgentWS(parentRoom, childRoom);
    const messages = await collectMessages(ws);
    const types = messages.map((m) => m.type);

    expect(types).toContain(MSG_CHAT_MESSAGES);
    expect(messages).not.toContainEqual(
      expect.objectContaining({
        type: MSG_STREAM_RESUMING,
        id: "req-parent-active"
      })
    );

    await closeWS(ws);
    await parent.testCompleteResumableStream(streamId);
  });

  it("does not handle child resume protocol messages in the parent agent", async () => {
    const parentRoom = crypto.randomUUID();
    const childRoom = crypto.randomUUID();
    const parent = await freshAgent(parentRoom);

    const streamId = await parent.testStartResumableStream("req-parent-active");

    const { ws } = await connectSubAgentWS(parentRoom, childRoom);
    await collectMessages(ws);

    ws.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    ws.send(
      JSON.stringify({
        type: MSG_STREAM_RESUME_ACK,
        id: "req-parent-active"
      })
    );

    const messages = await collectMessages(ws);
    expect(messages).not.toContainEqual(
      expect.objectContaining({
        type: MSG_STREAM_RESUMING,
        id: "req-parent-active"
      })
    );

    await closeWS(ws);
    await parent.testCompleteResumableStream(streamId);
  });

  it("resumes broadcasting CHAT_MESSAGES once the stream completes", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);

    const streamId = await agent.testStartResumableStream(
      "req-onconnect-cycle"
    );
    await agent.testCompleteResumableStream(streamId);

    const { ws } = await connectWS(room);
    const messages = await collectMessages(ws);
    const types = messages.map((m) => m.type);

    expect(types).toContain(MSG_CHAT_MESSAGES);
    expect(types).not.toContain(MSG_STREAM_RESUMING);

    await closeWS(ws);
  });

  it("finalizes resume if the stream completes before the client ACK arrives", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const requestId = "req-onconnect-ack-race";

    const streamId = await agent.testStartResumableStream(requestId);
    await agent.testStoreResumableChunk(
      streamId,
      '{"type":"text-delta","id":"t1","delta":"late hello"}'
    );
    const { ws } = await connectWS(room);
    const connectMessages = await collectMessages(ws);
    expect(connectMessages.map((m) => m.type)).toContain(MSG_STREAM_RESUMING);

    await agent.testCompleteResumableStream(streamId);
    ws.send(JSON.stringify({ type: MSG_STREAM_RESUME_ACK, id: requestId }));

    const ackMessages = await collectMessages(ws);
    const responseMessages = ackMessages.filter(
      (message) => message.type === MSG_CHAT_RESPONSE
    );
    expect(responseMessages[0]).toEqual(
      expect.objectContaining({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: '{"type":"text-delta","id":"t1","delta":"late hello"}',
        done: false,
        replay: true
      })
    );
    expect(responseMessages.at(-1)).toEqual(
      expect.objectContaining({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        done: true,
        replay: true
      })
    );

    await closeWS(ws);
  });
});
