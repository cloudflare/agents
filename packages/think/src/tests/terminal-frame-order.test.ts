/**
 * Regression coverage for #2119: the terminal `done` frame must follow the
 * transcript broadcast.
 *
 * `useAgentChat` flips to `ready` on `done`. If the persisted transcript
 * (`cf_agent_chat_messages`) arrives after that, it replaces the client's
 * message list and drops any message the user sent in between.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type { ThinkTestAgent } from "./agents/think-session";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";

type Frame =
  | { kind: "messages"; messages: UIMessage[] }
  | { kind: "done"; error: boolean };

async function freshAgent() {
  const room = crypto.randomUUID();
  const agent = await getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    room
  );
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { agent, ws };
}

/** Records transcript and terminal frames, in order, until `done`. */
function recordUntilDone(ws: WebSocket, timeout = 10_000): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as Record<string, unknown>;
      if (msg.type === MSG_CHAT_MESSAGES) {
        frames.push({
          kind: "messages",
          messages: msg.messages as UIMessage[]
        });
      } else if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
        frames.push({ kind: "done", error: msg.error === true });
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

function assistantText(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function expectTranscriptBeforeDone(frames: Frame[], text: string) {
  const doneIndex = frames.findIndex((frame) => frame.kind === "done");
  const transcriptIndex = frames.findIndex(
    (frame) =>
      frame.kind === "messages" &&
      frame.messages.at(-1)?.role === "assistant" &&
      assistantText(frame.messages.at(-1)).includes(text)
  );
  expect(transcriptIndex).toBeGreaterThanOrEqual(0);
  expect(transcriptIndex).toBeLessThan(doneIndex);
  expect(doneIndex).toBe(frames.length - 1);
}

describe("Think — terminal frame ordering (#2119)", () => {
  it("broadcasts the persisted transcript before done on a WebSocket turn", async () => {
    const { agent, ws } = await freshAgent();
    await agent.setResponse("Persisted before done");
    await settle();

    const frames = recordUntilDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
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
            ]
          })
        }
      })
    );

    const recorded = await frames;
    expectTranscriptBeforeDone(recorded, "Persisted before done");
    expect(recorded.at(-1)).toEqual({ kind: "done", error: false });
    ws.close();
  });

  it("broadcasts the persisted transcript before done on an RPC chat() turn", async () => {
    const { agent, ws } = await freshAgent();
    await agent.setResponse("RPC persisted before done");
    await settle();

    const frames = recordUntilDone(ws);
    await expect(agent.testChat("hello")).resolves.toMatchObject({
      done: true
    });

    const recorded = await frames;
    expectTranscriptBeforeDone(recorded, "RPC persisted before done");
    expect(recorded.at(-1)).toEqual({ kind: "done", error: false });
    ws.close();
  });

  it("broadcasts the persisted partial before the error frame when chat() fails mid-stream", async () => {
    const { agent, ws } = await freshAgent();
    await settle();

    const frames = recordUntilDone(ws);
    const result = await agent.testChatWithError("boom");
    expect(result.error).toContain("boom");

    const recorded = await frames;
    expectTranscriptBeforeDone(recorded, "");
    expect(recorded.at(-1)).toEqual({ kind: "done", error: true });
    ws.close();
  });
});
