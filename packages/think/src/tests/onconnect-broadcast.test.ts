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
});
