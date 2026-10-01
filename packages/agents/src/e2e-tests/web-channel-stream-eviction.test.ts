import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  killProcess,
  killProcessOnPort,
  startWrangler,
  waitForPortFree,
  waitForReady,
  type Harness
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18829;
const HARNESS: Harness = {
  configPath: path.join(__dirname, "../channels/live-tests/web/wrangler.jsonc"),
  port: PORT,
  persistDir: path.join(__dirname, ".wrangler-web-channel-stream-state")
};

const OBJECT_NAME = "web-channel-stream-eviction";
const CONVERSATION_ID = "eviction-conversation";
const REQUEST_ID = "request-before-eviction";
const APPROVAL_REQUEST_ID = "approval-request";

function socketUrl(): string {
  return (
    `ws://localhost:${PORT}/chat?name=${OBJECT_NAME}` +
    `&conversationId=${CONVERSATION_ID}&participantId=participant-1`
  );
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl());
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out opening Web replay socket"));
    }, 10_000);
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Failed to open Web replay socket"));
    };
  });
}

function approvalRoundTrip(socket: WebSocket): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const continuationChunks: unknown[] = [];
    let approvalSent = false;
    const timeout = setTimeout(() => {
      reject(new Error("Timed out completing the Web approval round trip"));
    }, 10_000);
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === "cf_agent_stream_resuming") {
        if (typeof frame.id !== "string") return;
        socket.send(
          JSON.stringify({
            type: "cf_agent_stream_resume_ack",
            id: frame.id
          })
        );
        return;
      }
      if (frame.type !== "cf_agent_use_chat_response") return;
      if (typeof frame.body === "string" && frame.body) {
        const chunk = JSON.parse(frame.body) as Record<string, unknown>;
        if (chunk.type === "tool-approval-request" && !approvalSent) {
          approvalSent = true;
          socket.send(
            JSON.stringify({
              type: "cf_agent_tool_approval",
              toolCallId: chunk.toolCallId,
              approved: true,
              autoContinue: true
            })
          );
        }
        if (frame.continuation === true) continuationChunks.push(chunk);
      }
      if (
        frame.id === APPROVAL_REQUEST_ID &&
        frame.done === true &&
        frame.continuation !== true
      ) {
        socket.send(
          JSON.stringify({
            type: "cf_agent_stream_resume_request",
            probeId: "approval-continuation"
          })
        );
      }
      if (frame.done === true && frame.continuation === true) {
        clearTimeout(timeout);
        resolve(continuationChunks);
      }
    };
    socket.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: APPROVAL_REQUEST_ID,
        init: {
          method: "POST",
          body: JSON.stringify({
            demo: "approval",
            messages: [
              {
                id: "approval-user-message",
                role: "user",
                parts: [{ type: "text", text: "Deploy this revision" }]
              }
            ]
          })
        }
      })
    );
  });
}

function waitForInitialResponse(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out producing the pre-eviction response"));
    }, 10_000);
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (
        frame.type === "cf_agent_use_chat_response" &&
        frame.id === REQUEST_ID &&
        frame.done === true
      ) {
        clearTimeout(timeout);
        resolve();
      }
    };
    socket.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: REQUEST_ID,
        init: {
          method: "POST",
          body: JSON.stringify({
            demo: "eviction-terminal",
            messages: [
              {
                id: "user-before-eviction",
                role: "user",
                parts: [{ type: "text", text: "Persist this response" }]
              }
            ]
          })
        }
      })
    );
  });
}

function clearConversation(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out clearing the Web conversation"));
    }, 10_000);
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type !== "cf_agent_chat_clear") return;
      clearTimeout(timeout);
      resolve();
    };
    socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
  });
}

function expectNoResponseToResume(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out checking reset response replay"));
    }, 10_000);
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (
        frame.type !== "cf_agent_stream_resume_none" ||
        frame.probeId !== "probe-after-reset"
      ) {
        return;
      }
      clearTimeout(timeout);
      resolve();
    };
    socket.send(
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-after-reset"
      })
    );
  });
}

function replayAfterRestart(socket: WebSocket): Promise<{
  offerId: string;
  chunks: unknown[];
  terminalFrames: number;
}> {
  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    let offerId = "";
    let terminalFrames = 0;
    const timeout = setTimeout(() => {
      reject(new Error("Timed out replaying the response after eviction"));
    }, 10_000);
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === "cf_agent_stream_resuming") {
        if (typeof frame.id !== "string") return;
        offerId = frame.id;
        socket.send(
          JSON.stringify({
            type: "cf_agent_stream_resume_ack",
            id: frame.id
          })
        );
        return;
      }
      if (frame.type !== "cf_agent_use_chat_response") return;
      if (typeof frame.body === "string" && frame.body) {
        chunks.push(JSON.parse(frame.body));
      }
      if (frame.done === true) {
        terminalFrames += 1;
        clearTimeout(timeout);
        resolve({ offerId, chunks, terminalFrames });
      }
    };
    socket.send(
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-after-process-restart"
      })
    );
  });
}

describe("Web Channel durable stream eviction e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (wrangler) {
      await killProcess(wrangler);
      wrangler = null;
    }
    killProcessOnPort(PORT);
    fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
  });

  it("routes an approval and application continuation through ChannelHost", async () => {
    wrangler = startWrangler(HARNESS);
    await waitForReady(HARNESS);

    const socket = await openSocket();
    const chunks = await approvalRoundTrip(socket);
    socket.close();

    expect(chunks).toEqual([
      {
        type: "start",
        messageId: "approval-response:approval:approval-user-message"
      },
      {
        type: "text-start",
        id: "approval-response:approval:approval-user-message:part:1"
      },
      {
        type: "text-delta",
        id: "approval-response:approval:approval-user-message:part:1",
        delta: "Application recorded: approve"
      },
      {
        type: "text-end",
        id: "approval-response:approval:approval-user-message:part:1"
      },
      { type: "finish", finishReason: "stop" }
    ]);
  });

  it("hydrates history and replays a terminal response after Wrangler restarts", async () => {
    wrangler = startWrangler(HARNESS);
    await waitForReady(HARNESS);

    const initial = await fetch(
      `http://localhost:${PORT}/chat/get-messages?name=${OBJECT_NAME}` +
        `&conversationId=${CONVERSATION_ID}&participantId=participant-1`
    );
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toEqual([
      {
        id: "prior-user",
        role: "user",
        parts: [{ type: "text", text: "Prior canonical question" }]
      },
      {
        id: "prior-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Prior canonical answer" }]
      }
    ]);

    const original = await openSocket();
    await waitForInitialResponse(original);
    original.close();

    await killProcess(wrangler);
    wrangler = null;
    killProcessOnPort(PORT);
    await waitForPortFree(HARNESS);

    wrangler = startWrangler(HARNESS);
    await waitForReady(HARNESS);

    const replacement = await openSocket();
    const replayed = await replayAfterRestart(replacement);

    expect(replayed.offerId).toBe(REQUEST_ID);
    expect(replayed.terminalFrames).toBe(1);
    expect(replayed.chunks).toEqual([
      {
        type: "start",
        messageId: "assistant:user-before-eviction"
      },
      {
        type: "text-start",
        id: "assistant:user-before-eviction:part:1"
      },
      {
        type: "text-delta",
        id: "assistant:user-before-eviction:part:1",
        delta: "Durable response after process eviction"
      },
      {
        type: "text-end",
        id: "assistant:user-before-eviction:part:1"
      },
      { type: "finish", finishReason: "stop" }
    ]);

    await clearConversation(replacement);
    await expectNoResponseToResume(replacement);
    replacement.close();
    const cleared = await fetch(
      `http://localhost:${PORT}/chat/get-messages?name=${OBJECT_NAME}` +
        `&conversationId=${CONVERSATION_ID}&participantId=participant-1`
    );
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual([]);
  });
});
