import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName, getSubAgentByName } from "agents";
import { ThinkTestAgent } from "./agents/think-session";

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

function waitForRequestFrameTypes(
  ws: WebSocket,
  requestId: string,
  expectedTypes: ReadonlySet<string>,
  timeout = 2000
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const received: string[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(
        new Error(
          `Expected request frames never arrived; received ${JSON.stringify(received)}`
        )
      );
    }, timeout);

    const onMessage = (event: MessageEvent) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      if (
        frame.id !== requestId ||
        typeof frame.type !== "string" ||
        !expectedTypes.has(frame.type)
      ) {
        return;
      }

      received.push(frame.type);
      if (received.length !== expectedTypes.size) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(received);
    };

    ws.addEventListener("message", onMessage);
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
    // Marks the transcript as predating any sends the client buffered while
    // disconnected, so `useAgentChat` keeps them (#1983).
    expect(messages).toContainEqual(
      expect.objectContaining({ type: MSG_CHAT_MESSAGES, connect: true })
    );

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

describe("Think — unacknowledged resume offers", () => {
  it.each(["finish", "complete", "error"] as const)(
    "delivers the done frame once the offered stream ends (%s)",
    async (close) => {
      const room = crypto.randomUUID();
      const agent = await freshAgent(room);
      const { ws } = await connectWS(room);
      try {
        await collectMessages(ws);
        const requestId = crypto.randomUUID();
        const frames = waitForRequestFrameTypes(
          ws,
          requestId,
          new Set([MSG_STREAM_RESUMING, MSG_CHAT_RESPONSE])
        );

        await agent.testEndStreamOfferedWithoutAck(requestId, close);

        await expect(frames).resolves.toEqual([
          MSG_STREAM_RESUMING,
          MSG_CHAT_RESPONSE
        ]);
      } finally {
        await closeWS(ws);
      }
    }
  );
});

describe("Think — message lists inside a facet", () => {
  it("sends the list on connect and after a turn to a sub-agent's socket", async () => {
    const parentRoom = crypto.randomUUID();
    const childRoom = crypto.randomUUID();
    const parent = await freshAgent(parentRoom);
    const { ws } = await connectSubAgentWS(parentRoom, childRoom);
    try {
      const onConnect = await collectMessages(ws);
      expect(onConnect).toContainEqual(
        expect.objectContaining({ type: MSG_CHAT_MESSAGES, connect: true })
      );

      const child = await getSubAgentByName(parent, ThinkTestAgent, childRoom);
      const lists: Array<Array<{ role: string }>> = [];
      ws.addEventListener("message", (event: MessageEvent) => {
        const frame = JSON.parse(event.data as string) as {
          type?: string;
          messages?: Array<{ role: string }>;
        };
        if (frame.type === MSG_CHAT_MESSAGES && frame.messages) {
          lists.push(frame.messages);
        }
      });
      const result = await child.testChat("hello from the facet");
      expect(result.done).toBe(true);
      // Forwarding to a facet's sockets is not awaited by the broadcast.
      await vi.waitFor(
        () =>
          expect(lists.at(-1)?.map((message) => message.role)).toEqual([
            "user",
            "assistant"
          ]),
        { timeout: 5000 }
      );
    } finally {
      await closeWS(ws);
    }
  });
});

describe("Think — sub-agent stream frame ordering", () => {
  it("delivers STREAM_RESUMING before a later terminal broadcast", async () => {
    const parentRoom = crypto.randomUUID();
    const childRoom = crypto.randomUUID();
    const parent = await freshAgent(parentRoom);
    const { ws } = await connectSubAgentWS(parentRoom, childRoom);
    try {
      await collectMessages(ws);

      const child = await getSubAgentByName(parent, ThinkTestAgent, childRoom);
      await parent.delayNextSubAgentConnectionSendForTest(300);
      const requestId = crypto.randomUUID();
      const frames = waitForRequestFrameTypes(
        ws,
        requestId,
        new Set([MSG_STREAM_RESUMING, MSG_CHAT_RESPONSE])
      );

      await child.testSendStreamResumingBeforeTerminal(requestId);

      await expect(frames).resolves.toEqual([
        MSG_STREAM_RESUMING,
        MSG_CHAT_RESPONSE
      ]);
    } finally {
      await closeWS(ws);
    }
  });
});

// #1645: a turn that terminalizes (recovery exhaustion / interruption) while no
// client is connected must be surfaced to a client that reconnects afterward.
// Think records the outcome durably, but currently only replays it as a RAW
// `cf_agent_use_chat_response` frame in `_buildIdleConnectMessages` on connect —
// which the shared `useAgentChat` client DROPS (it never reaches a transport
// stream reader, so it never becomes `useChat.error`). The only path that
// surfaces on the real client is the resume handshake: STREAM_RESUMING → ACK →
// error frame on the resumed stream (this is what `@cloudflare/ai-chat` does).
// This test drives the exact reconnect probe the real client sends and asserts
// the terminal is delivered over that handshake.
describe("Think — terminal replay on reconnect (#1645)", () => {
  const MSG_STREAM_RESUME_REQUEST = "cf_agent_stream_resume_request";
  const TERMINAL = "Recovery exhausted — the assistant could not finish.";

  it("delivers the terminal over the resume handshake to a client that reconnects after it ended", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);

    // A turn terminalized while no client was connected.
    await (
      agent as unknown as {
        recordTerminalForTest: (id: string, body: string) => Promise<void>;
      }
    ).recordTerminalForTest("root-think", TERMINAL);

    const { ws } = await connectWS(room);

    const received: Array<Record<string, unknown>> = [];
    let resumingId: string | null = null;
    const terminalViaHandshake = await new Promise<Record<
      string,
      unknown
    > | null>((resolve) => {
      let acked = false;
      const timer = setTimeout(() => resolve(null), 1500);
      ws.addEventListener("message", (e: MessageEvent) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(e.data as string) as Record<string, unknown>;
        } catch {
          return;
        }
        received.push(frame);
        if (frame.type === MSG_STREAM_RESUMING) {
          resumingId = frame.id as string;
          acked = true;
          ws.send(
            JSON.stringify({ type: MSG_STREAM_RESUME_ACK, id: frame.id })
          );
        }
        // Only count a terminal error frame delivered AFTER the resume
        // handshake — the raw on-connect frame is dropped by the real client.
        if (
          acked &&
          frame.type === MSG_CHAT_RESPONSE &&
          frame.error === true &&
          frame.done === true
        ) {
          clearTimeout(timer);
          resolve(frame);
        }
      });

      ws.send(JSON.stringify({ type: MSG_STREAM_RESUME_REQUEST }));
    });

    await closeWS(ws);

    expect(
      resumingId,
      `expected STREAM_RESUMING for the terminal on reconnect; received frame types: ${JSON.stringify(
        received.map((m) => m.type)
      )}`
    ).toBe("root-think");
    expect(terminalViaHandshake?.body).toBe(TERMINAL);
  });

  it("drops the terminal record when the conversation is cleared", async () => {
    const room = crypto.randomUUID();
    const agent = (await freshAgent(room)) as unknown as {
      recordTerminalForTest: (id: string, body: string) => Promise<void>;
      getPendingChatTerminalForTest: () => Promise<{
        requestId: string;
        body: string;
      } | null>;
      clearMessages: () => Promise<void>;
    };

    await agent.recordTerminalForTest("root-clear", TERMINAL);
    expect(await agent.getPendingChatTerminalForTest()).toMatchObject({
      body: TERMINAL
    });

    // Clearing the conversation must also drop the terminal record, otherwise a
    // stale exhaustion would replay onto the now-empty chat on reconnect (#1645).
    await agent.clearMessages();
    expect(await agent.getPendingChatTerminalForTest()).toBeNull();
  });

  it("eagerly drops the terminal record when a new turn is submitted, before it streams (#1645)", async () => {
    const room = crypto.randomUUID();
    const agent = (await freshAgent(room)) as unknown as {
      recordTerminalForTest: (id: string, body: string) => Promise<void>;
      getPendingChatTerminalForTest: () => Promise<{
        requestId: string;
        body: string;
      } | null>;
      setBeforeStepAsyncDelay: (ms: number) => Promise<void>;
    };

    // A previous turn failed terminally.
    await agent.recordTerminalForTest("root-old", TERMINAL);
    // Park the NEW turn indefinitely at its first step so it never reaches
    // completion during this test. This isolates the eager submit-time clear
    // from the turn-completion clear: any observed clear must come from the
    // submit path, not from the new turn finishing.
    await agent.setBeforeStepAsyncDelay(60_000);

    const { ws } = await connectWS(room);
    await collectMessages(ws, 100); // drain the on-connect frames

    // Submit a genuinely-new turn. The user hasn't waited for it to stream.
    ws.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "root-new",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "u-new",
                role: "user",
                parts: [{ type: "text", text: "hi" }]
              }
            ]
          })
        }
      })
    );

    // The eager clear lands at submit time, while the new turn is still parked
    // in `beforeStep`. Without it, a reconnecting tab in this window would
    // replay `root-old`'s stale exhaustion over the resume handshake.
    let pending = await agent.getPendingChatTerminalForTest();
    for (let i = 0; i < 50 && pending !== null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = await agent.getPendingChatTerminalForTest();
    }
    expect(pending).toBeNull();

    await closeWS(ws);
  });
});

// Successor of think-session's "replays a terminal error to a reconnecting
// client (hydration)", through a turn that really fails and tabs that
// really reconnect.
describe("the terminal a reconnecting tab is told", () => {
  function chatTurn(
    ws: WebSocket,
    text: string
  ): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    // Whether the turn's frames carried an error, once its stream is done.
    const done = new Promise<{ error: boolean }>((resolve) => {
      let error = false;
      ws.addEventListener("message", (e: MessageEvent) => {
        const frame = JSON.parse(e.data as string) as Record<string, unknown>;
        if (frame.type !== MSG_CHAT_RESPONSE || frame.id !== id) return;
        if (frame.error === true) error = true;
        if (frame.done) resolve({ error });
      });
    });
    ws.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text }]
              }
            ]
          })
        }
      })
    );
    return done;
  }

  /** A tab connects and resumes as useChat does: the error it hears, if any. */
  async function reconnect(room: string): Promise<string | null> {
    const { ws } = await connectWS(room);
    const heard = await new Promise<string | null>((resolve) => {
      let acked = false;
      ws.addEventListener("message", (e: MessageEvent) => {
        const frame = JSON.parse(e.data as string) as Record<string, unknown>;
        if (frame.type === MSG_STREAM_RESUMING) {
          acked = true;
          ws.send(
            JSON.stringify({ type: MSG_STREAM_RESUME_ACK, id: frame.id })
          );
        }
        if (frame.type === "cf_agent_stream_resume_none") resolve(null);
        if (
          acked &&
          frame.type === MSG_CHAT_RESPONSE &&
          frame.error === true &&
          frame.done === true
        ) {
          resolve(String(frame.body ?? ""));
        }
      });
      ws.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    });
    await closeWS(ws);
    return heard;
  }

  it("tells a tab that reconnects after a turn failed, and stops once a later turn completes", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.setInBandErrorResponse("provider exploded");
    const { ws } = await connectWS(room);
    expect((await chatTurn(ws, "fail please")).error).toBe(true);
    await closeWS(ws);

    // A tab that missed the live error learns it on reconnect.
    expect(await reconnect(room)).toContain("provider exploded");

    // A later turn completes: no tab is told the old error again.
    await agent.clearInBandErrorResponse();
    const { ws: again } = await connectWS(room);
    expect((await chatTurn(again, "now work")).error).toBe(false);
    await closeWS(again);
    expect(await reconnect(room)).toBeNull();
  });
});

describe("chat frames with no client (#2724)", () => {
  type Counting = {
    countChatFrameSerializationsForTest(
      message: string
    ): Promise<Record<string, number>>;
  };

  it("serializes no chat frame when no client is connected", async () => {
    const agent = (await freshAgent()) as unknown as Counting;
    await agent.countChatFrameSerializationsForTest("first");
    expect(await agent.countChatFrameSerializationsForTest("second")).toEqual(
      {}
    );
  });

  it("serializes no chat frame in a sub-agent no client has open", async () => {
    const parent = await freshAgent();
    const child = (await getSubAgentByName(
      parent,
      ThinkTestAgent,
      crypto.randomUUID()
    )) as unknown as Counting;
    await child.countChatFrameSerializationsForTest("first");
    expect(await child.countChatFrameSerializationsForTest("second")).toEqual(
      {}
    );
  });

  it("still sends the frames to a connected client", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(room);
    const seen: string[] = [];
    ws.addEventListener("message", (event: MessageEvent) => {
      const type = (JSON.parse(event.data as string) as { type?: string }).type;
      if (type === MSG_CHAT_MESSAGES || type === MSG_CHAT_RESPONSE) {
        seen.push(type);
      }
    });
    const agent = (await freshAgent(room)) as unknown as Counting;
    const counts = await agent.countChatFrameSerializationsForTest("hello");
    await vi.waitFor(() => {
      expect(seen).toContain(MSG_CHAT_RESPONSE);
      expect(seen).toContain(MSG_CHAT_MESSAGES);
    });
    expect(counts[MSG_CHAT_RESPONSE]).toBeGreaterThan(0);
    ws.close();
  });
});
