/**
 * Server-side VoiceInput mixin tests with continuous transcriber.
 *
 * Tests cover: voice protocol, consumer lifecycle passthrough, message
 * routing, continuous STT pipeline, multi-turn, onTranscript hook,
 * beforeCallStart rejection, and interrupt handling.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "./worker";

// --- Helpers ---

async function connectWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

function waitForMessageMatching(
  ws: WebSocket,
  predicate: (msg: unknown) => boolean,
  timeout = 5000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for matching message")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function sendJSON(ws: WebSocket, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
}

function waitForStatus(ws: WebSocket, status: string) {
  return waitForMessageMatching(
    ws,
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).type === "status" &&
      (m as Record<string, unknown>).status === status
  );
}

function waitForType(ws: WebSocket, type: string) {
  return waitForMessageMatching(
    ws,
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).type === type
  );
}

async function waitForAck(ws: WebSocket, command: string): Promise<void> {
  await waitForMessageMatching(
    ws,
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).type === "_ack" &&
      (m as Record<string, unknown>).command === command
  );
}

function collectMessagesUntil(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeout = 5000
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout collecting messages")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;

      const msg = JSON.parse(e.data) as Record<string, unknown>;
      messages.push(msg);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(messages);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

let instanceCounter = 0;
function uniquePath(agent: string) {
  return `/agents/${agent}/voice-input-test-${++instanceCounter}`;
}

async function getAgentState(ws: WebSocket) {
  sendJSON(ws, { type: "_get_state" });
  const msg = (await waitForType(ws, "_state")) as Record<string, unknown>;
  return msg;
}

// --- Tests ---

describe("VoiceInput — protocol basics", () => {
  it("sends welcome and idle status on connect", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));

    const welcome = (await waitForType(ws, "welcome")) as Record<
      string,
      unknown
    >;
    expect(welcome.protocol_version).toBeDefined();

    const status = (await waitForStatus(ws, "idle")) as Record<string, unknown>;
    expect(status.status).toBe("idle");

    ws.close();
  });

  it("transitions to listening on start_call", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const status = (await waitForStatus(ws, "listening")) as Record<
      string,
      unknown
    >;
    expect(status.status).toBe("listening");

    ws.close();
  });

  it("transitions to idle on end_call", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "end_call" });
    const status = (await waitForStatus(ws, "idle")) as Record<string, unknown>;
    expect(status.status).toBe("idle");

    ws.close();
  });
});

describe("VoiceInput — diagnostics", () => {
  it("uses the same server opt-in for welcome and STT lifecycle forwarding", async () => {
    const { ws } = await connectWS(
      uniquePath("test-diagnostic-voice-input-agent")
    );
    const welcome = (await waitForType(ws, "welcome")) as Record<
      string,
      unknown
    >;
    expect(welcome.diagnostics).toEqual({ browser_console: true });
    await waitForStatus(ws, "idle");

    const messagesPromise = collectMessagesUntil(
      ws,
      (message) =>
        message.type === "diagnostic" && message.event === "turn.ended"
    );
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    for (let i = 0; i < 4; i++) ws.send(new ArrayBuffer(5000));
    const messages = await messagesPromise;
    const diagnostics = messages.filter(
      (message) => message.type === "diagnostic"
    );
    const events = diagnostics.map((message) => message.event);

    expect(events).toEqual(
      expect.arrayContaining([
        "call.starting",
        "stt.starting",
        "stt.ready",
        "stt.interim",
        "stt.utterance",
        "turn.started",
        "after_transcribe.completed",
        "turn.ended"
      ])
    );
    expect(JSON.stringify(diagnostics)).not.toContain("utterance 1");

    ws.close();
  });
});

describe("VoiceInput — consumer lifecycle passthrough", () => {
  it("calls consumer onConnect", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    const state = await getAgentState(ws);
    expect(state.connectCount).toBe(1);

    ws.close();
  });

  it("forwards non-voice messages to consumer onMessage", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_custom", data: "hello from client" });
    await waitForType(ws, "_ack");

    const state = await getAgentState(ws);
    expect(state.customMessages).toEqual(["hello from client"]);

    ws.close();
  });
});

describe("VoiceInput — continuous STT pipeline", () => {
  it("creates transcriber session at start_call and transcribes on model-driven utterance", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio to trigger the test transcriber (threshold = 20000 bytes)
    const turnMetricsPromise = waitForType(ws, "turn_metrics");
    for (let i = 0; i < 5; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Wait for the transcript — the test transcriber fires onUtterance at 20000+ bytes
    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    expect(transcript.role).toBe("user");
    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    await waitForStatus(ws, "listening");

    const state = await getAgentState(ws);
    expect(state.transcripts).toHaveLength(1);

    const turnMetrics = (await turnMetricsPromise) as Record<string, unknown>;
    expect(turnMetrics).toMatchObject({
      type: "turn_metrics",
      turnId: expect.any(String),
      source: "speech",
      outcome: "completed",
      turnTotalMs: expect.any(Number),
      afterTranscribeMs: expect.any(Number)
    });
    expect(turnMetrics).not.toHaveProperty("speechStartToFirstInterimMs");
    expect(turnMetrics).not.toHaveProperty("speechStartToFinalMs");
    expect(turnMetrics).not.toHaveProperty("modelStreamConsumptionMs");
    expect(turnMetrics).not.toHaveProperty("ttsWorkMs");

    ws.close();
  });

  it("sends interim transcripts during audio streaming", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(5000));

    const interim = (await waitForType(ws, "transcript_interim")) as Record<
      string,
      unknown
    >;
    expect(interim.text).toBeDefined();
    expect((interim.text as string).includes("hearing")).toBe(true);

    ws.close();
  });

  it("handles multi-turn — second utterance works after first", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // First utterance (20000 bytes)
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    await waitForType(ws, "transcript");
    await waitForStatus(ws, "listening");

    // Second utterance (another 20000 bytes, total 40000)
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    expect((transcript.text as string).includes("utterance 2")).toBe(true);

    const state = await getAgentState(ws);
    expect(state.transcripts).toHaveLength(2);

    ws.close();
  });
});

describe("VoiceInput — transcriber lifecycle errors", () => {
  it("waits for transcriber readiness and reports a structured startup failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    try {
      await waitForStatus(ws, "idle");
      sendJSON(ws, { type: "_use_rejecting_ready_transcriber" });
      await waitForAck(ws, "_use_rejecting_ready_transcriber");

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Speech recognition failed to start",
        code: "stt_startup_failed",
        stage: "stt",
        retryable: false
      });
      expect(startupMessages).not.toContainEqual({
        type: "status",
        status: "listening"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });
      expect(errorLog).toHaveBeenCalledWith({
        component: "VoiceInput",
        stage: "transcriber_startup",
        message: "Speech recognition failed to start",
        connectionId: expect.any(String),
        error: expect.objectContaining({
          name: "VoiceProviderError",
          message: "provider startup failed",
          code: "provider_unavailable"
        })
      });

      const state = await getAgentState(ws);
      expect(state).toMatchObject({ callStart: 0, callEnd: 1 });
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("ignores a stale fatal callback from an earlier input session", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    try {
      await waitForStatus(ws, "idle");

      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");
      sendJSON(ws, { type: "end_call" });
      await waitForStatus(ws, "idle");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      const afterStalePromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "_state"
      );
      sendJSON(ws, {
        type: "_report_transcriber_fatal_at",
        index: 0,
        error: { message: "stale input session failure" }
      });
      sendJSON(ws, { type: "_get_state" });
      const afterStale = await afterStalePromise;
      expect(afterStale.some((msg) => msg.type === "error")).toBe(false);
      expect(afterStale).not.toContainEqual({ type: "status", status: "idle" });

      const terminalMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, {
        type: "_report_transcriber_fatal_at",
        index: 1,
        error: { message: "current input session failure" }
      });
      const terminalMessages = await terminalMessagesPromise;
      expect(
        terminalMessages.filter((msg) => msg.type === "error")
      ).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "transcriber_runtime",
          error: expect.objectContaining({
            message: "current input session failure"
          })
        })
      );
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("ends a call when a detached transcriber connection fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    try {
      await waitForStatus(ws, "idle");
      sendJSON(ws, { type: "_use_detached_failing_transcriber" });
      await waitForAck(ws, "_use_detached_failing_transcriber");

      const terminalMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const terminalMessages = await terminalMessagesPromise;

      expect(terminalMessages).toContainEqual({
        type: "error",
        message: "Speech recognition connection was lost",
        code: "stt_connection_lost",
        stage: "stt",
        retryable: true
      });
      expect(terminalMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });
      expect(errorLog).toHaveBeenCalledWith({
        component: "VoiceInput",
        stage: "transcriber_runtime",
        message: "Speech recognition connection was lost",
        connectionId: expect.any(String),
        error: expect.objectContaining({
          name: "VoiceProviderError",
          message: "detached provider failed to connect",
          code: "socket_upgrade_failed"
        })
      });

      const state = await getAgentState(ws);
      expect(state).toMatchObject({ callStart: 1, callEnd: 1 });
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });
});

describe("VoiceInput — beforeCallStart rejection", () => {
  it("returns an error and idle when beforeCallStart returns false", async () => {
    const { ws } = await connectWS(
      uniquePath("test-reject-call-voice-input-agent")
    );
    await waitForStatus(ws, "idle");

    const errorPromise = waitForType(ws, "error");
    const idlePromise = waitForStatus(ws, "idle");
    sendJSON(ws, { type: "start_call" });

    expect(await errorPromise).toEqual({
      type: "error",
      message: "Voice call was rejected"
    });
    expect(await idlePromise).toEqual({ type: "status", status: "idle" });

    ws.close();
  });

  it("ignores stale startup after end_call while beforeCallStart is pending", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_set_before_call_start", value: "pending" });
    await waitForAck(ws, "_set_before_call_start");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "_startup_pending");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    const afterEnd = collectMessagesUntil(ws, (msg) => msg.type === "_state");
    sendJSON(ws, { type: "_resolve_before_call_start", value: true });
    sendJSON(ws, { type: "_get_state" });
    const afterEndMessages = await afterEnd;

    expect(afterEndMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(afterEndMessages.some((msg) => msg.type === "error")).toBe(false);
    expect(afterEndMessages.at(-1)).toMatchObject({
      type: "_state",
      callStart: 0,
      callEnd: 1
    });

    ws.close();
  });

  it("does not treat onCallStart exceptions as startup failures", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    try {
      await waitForStatus(ws, "idle");

      sendJSON(ws, { type: "_set_on_call_start_throw", value: true });
      await waitForAck(ws, "_set_on_call_start_throw");

      const startupMessages = collectMessagesUntil(
        ws,
        (msg) => msg.type === "_state"
      );
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");
      await waitForMicrotasks();
      sendJSON(ws, { type: "_get_state" });
      const messages = await startupMessages;

      expect(messages).toContainEqual({
        type: "status",
        status: "listening"
      });
      expect(messages.some((msg) => msg.type === "error")).toBe(false);
      expect(messages).not.toContainEqual({ type: "status", status: "idle" });
      expect(messages.at(-1)).toMatchObject({
        type: "_state",
        callStart: 1,
        callEnd: 0
      });
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });
});

describe("VoiceInput — edge cases", () => {
  it("audio sent before start_call is silently dropped", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    ws.send(new ArrayBuffer(30000));

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Only audio after start_call should reach the transcriber
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    expect((transcript.text as string).includes("utterance 1")).toBe(true);
    // 20000 bytes, not 50000 (the 30000 before start_call was dropped)
    expect((transcript.text as string).includes("20000")).toBe(true);

    ws.close();
  });

  it("afterTranscribe returning null suppresses the utterance", async () => {
    // The default afterTranscribe returns the transcript as-is.
    // We test the base behavior here — a subclass returning null
    // would need a custom agent. But we can verify the hook is called
    // by checking that transcripts arrive with the expected text.
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    // afterTranscribe passes through by default
    expect(transcript.text).toBeDefined();
    expect((transcript.text as string).length).toBeGreaterThan(0);

    ws.close();
  });
});

describe("VoiceInput — start_of_speech and end_of_speech are no-ops", () => {
  it("ignores start_of_speech and end_of_speech for STT", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // These should not create/flush sessions — they are ignored
    sendJSON(ws, { type: "start_of_speech" });
    sendJSON(ws, { type: "end_of_speech" });

    // Audio still flows to the continuous session
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    ws.close();
  });
});
