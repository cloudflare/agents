/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/errored-stream-replay.test.ts
 * - last original change: f6a8bc4a
 * - port date: 2026-07-15
 * Modifications:
 * - Rewritten from the original private `_replayTerminalOnAck` helper onto
 *   the rebuild's public WebSocket reconnect + resume-ACK path.
 * - Re-pointed fixture type import to `./fixtures/index.js`.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getServerByName } from "./compat.js";
import type { ThinkTestAgent } from "./fixtures/index.js";

const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_STREAM_RESUME_ACK = "cf_agent_stream_resume_ack";
const MSG_STREAM_RESUMING = "cf_agent_stream_resuming";

type Frame = Record<string, unknown>;

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

async function connectWS(room: string) {
  const res = await (
    exports as { default: { fetch: typeof fetch } }
  ).default.fetch(`http://example.com/agents/think-test-agent/${room}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function collectMessages(ws: WebSocket, timeout = 500): Promise<Frame[]> {
  return new Promise((resolve) => {
    const messages: Frame[] = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string) as Frame);
      } catch {
        // Ignore non-JSON frames.
      }
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

describe("Think errored stream replay (#1575)", () => {
  it("replays pre-error partial content before the terminal error on resume-ACK", async () => {
    const room = `inband-replay-${crypto.randomUUID()}`;
    const requestId = "req-inband-replay";
    const agent = await freshAgent(room);

    await agent.testStartErroredReplayStream(requestId, "boom");

    const { ws } = await connectWS(room);
    const connectMessages = await collectMessages(ws);
    expect(connectMessages).toContainEqual(
      expect.objectContaining({
        type: MSG_STREAM_RESUMING,
        id: requestId
      })
    );

    await agent.testFinishErroredReplayStream();
    ws.send(JSON.stringify({ type: MSG_STREAM_RESUME_ACK, id: requestId }));

    const frames = await collectMessages(ws);
    await closeWS(ws);

    const responseFrames = frames.filter((f) => f.type === MSG_CHAT_RESPONSE);
    const replayBodies = responseFrames
      .filter((f) => f.replay === true && typeof f.body === "string")
      .map((f) => f.body as string)
      .join("");
    expect(replayBodies).toContain("partial response");

    const terminal = responseFrames[responseFrames.length - 1];
    expect(terminal).toEqual(
      expect.objectContaining({
        type: MSG_CHAT_RESPONSE,
        done: true,
        error: true,
        body: "boom"
      })
    );

    const terminalIndex = responseFrames.findIndex(
      (f) => f.done === true && f.error === true
    );
    const firstReplayIndex = responseFrames.findIndex((f) => f.replay === true);
    expect(firstReplayIndex).toBeGreaterThanOrEqual(0);
    expect(firstReplayIndex).toBeLessThan(terminalIndex);
  });
});
