/**
 * Server-side VoiceAgent tests with continuous transcriber.
 *
 * Tests cover: voice protocol, continuous STT pipeline flow,
 * multi-turn conversation, interruption handling (session survives),
 * text messages, conversation persistence, and the beforeCallStart hook.
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

let instanceCounter = 0;
function uniquePath() {
  return `/agents/test-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueDiagnosticPath() {
  return `/agents/test-diagnostic-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueContextPath() {
  return `/agents/test-context-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueAISDKStreamPath() {
  return `/agents/test-ai-sdk-full-stream-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueAISDKTextStreamPath() {
  return `/agents/test-ai-sdk-text-stream-voice-agent/voice-test-${++instanceCounter}`;
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

async function setTranscriberMode(
  ws: WebSocket,
  value:
    | "default"
    | "missing"
    | "pending_ready"
    | "pending_ready_no_close_settle"
    | "reject_ready"
    | "reject_ready_object"
    | "create_throw"
): Promise<void> {
  sendJSON(ws, { type: "_set_transcriber_mode", value });
  await waitForAck(ws, "_set_transcriber_mode");
}

async function setBeforeCallStart(
  ws: WebSocket,
  value: boolean | "throw"
): Promise<void> {
  sendJSON(ws, { type: "_set_before_call_start", value });
  await waitForAck(ws, "_set_before_call_start");
}

async function setKeepAliveThrow(ws: WebSocket, value: boolean): Promise<void> {
  sendJSON(ws, { type: "_set_keep_alive_throw", value });
  await waitForAck(ws, "_set_keep_alive_throw");
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function waitForBinary(ws: WebSocket, timeout = 5000): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for binary message"));
    }, timeout);
    const handler = (e: MessageEvent) => {
      void toArrayBuffer(e.data).then(
        (buffer) => {
          if (settled || !buffer) return;
          cleanup();
          resolve(buffer);
        },
        (error: unknown) => {
          if (settled) return;
          cleanup();
          reject(error);
        }
      );
    };
    ws.addEventListener("message", handler);
  });
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer | null> {
  if (data instanceof ArrayBuffer) return data;

  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
      .buffer as ArrayBuffer;
  }

  if (data instanceof Blob) return data.arrayBuffer();

  return null;
}

function decodeAudio(buffer: ArrayBuffer): string {
  return String.fromCharCode(...new Uint8Array(buffer));
}

function recordVoiceEvents(ws: WebSocket) {
  const events: Array<Record<string, unknown> | "audio"> = [];
  const handler = (event: MessageEvent) => {
    if (typeof event.data === "string") {
      events.push(JSON.parse(event.data) as Record<string, unknown>);
    } else {
      events.push("audio");
    }
  };
  ws.addEventListener("message", handler);

  return {
    events,
    stop: () => ws.removeEventListener("message", handler)
  };
}

function statusAndAudioSequence(
  events: Array<Record<string, unknown> | "audio">
): unknown[] {
  return events.flatMap((event) => {
    if (event === "audio") return [event];
    return event.type === "status" ? [event.status] : [];
  });
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

// --- Tests ---

describe("VoiceAgent — protocol", () => {
  it("sends idle status on connect", async () => {
    const { ws } = await connectWS(uniquePath());
    const msg = await waitForStatus(ws, "idle");
    expect(msg).toEqual({ type: "status", status: "idle" });
    ws.close();
  });

  it("sends listening status on start_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const msg = await waitForStatus(ws, "listening");
    expect(msg).toEqual({ type: "status", status: "listening" });
    ws.close();
  });

  it("sends idle status on end_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "end_call" });
    const msg = await waitForStatus(ws, "idle");
    expect(msg).toEqual({ type: "status", status: "idle" });
    ws.close();
  });

  it("sends audio_config on start_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const config = (await waitForType(ws, "audio_config")) as Record<
      string,
      unknown
    >;
    expect(config.format).toBe("mp3");
    expect(config.sampleRate).toBe(16000);
    ws.close();
  });

  it("sends configured sampleRate in audio_config", async () => {
    const { ws } = await connectWS(
      `/agents/test-pcm24k-voice-agent/voice-test-${++instanceCounter}`
    );
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const config = (await waitForType(ws, "audio_config")) as Record<
      string,
      unknown
    >;
    expect(config.format).toBe("pcm16");
    expect(config.sampleRate).toBe(24000);
    ws.close();
  });
});

describe("VoiceAgent — diagnostics", () => {
  it("keeps diagnostics off unless the server mixin enables them", async () => {
    const { ws } = await connectWS(uniquePath());
    const welcome = (await waitForType(ws, "welcome")) as Record<
      string,
      unknown
    >;
    expect(welcome).not.toHaveProperty("diagnostics");
    await waitForStatus(ws, "idle");

    const messagesPromise = collectMessagesUntil(
      ws,
      (message) => message.type === "status" && message.status === "listening"
    );
    sendJSON(ws, { type: "start_call" });
    const messages = await messagesPromise;

    expect(messages.some((message) => message.type === "diagnostic")).toBe(
      false
    );
    ws.close();
  });

  it("activates forwarding in welcome and reports an ordered safe lifecycle", async () => {
    const { ws } = await connectWS(uniqueDiagnosticPath());
    const welcome = (await waitForType(ws, "welcome")) as Record<
      string,
      unknown
    >;
    expect(welcome).toMatchObject({
      protocol_version: expect.any(Number),
      diagnostics: { browser_console: true }
    });
    await waitForStatus(ws, "idle");

    const messagesPromise = collectMessagesUntil(
      ws,
      (message) => message.type === "turn_metrics"
    );
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    for (let i = 0; i < 4; i++) ws.send(new ArrayBuffer(5000));
    const messages = await messagesPromise;
    const diagnostics = messages.filter(
      (message) => message.type === "diagnostic"
    );
    const events = diagnostics.map((message) => message.event);

    const expectedOrder = [
      "call.starting",
      "stt.starting",
      "stt.ready",
      "call.ready",
      "turn.started",
      "speech.started",
      "stt.interim",
      "stt.utterance",
      "after_transcribe.completed",
      "model.started",
      "model.first_text",
      "model.completed",
      "tts.started",
      "tts.completed",
      "audio.first_sent",
      "audio.completed",
      "turn.ended"
    ];
    let cursor = -1;
    for (const event of expectedOrder) {
      cursor = events.indexOf(event, cursor + 1);
      expect(
        cursor,
        `missing or unordered diagnostic: ${event}`
      ).toBeGreaterThan(-1);
    }

    const turnMetrics = messages.find(
      (message) => message.type === "turn_metrics"
    ) as Record<string, unknown>;
    const correlatedIds = diagnostics
      .filter((message) =>
        [
          "turn.started",
          "speech.started",
          "stt.interim",
          "stt.utterance",
          "model.started",
          "tts.started",
          "audio.first_sent",
          "turn.ended"
        ].includes(message.event as string)
      )
      .map(
        (message) =>
          (message.data as Record<string, unknown> | undefined)?.turn_id
      );
    expect(new Set(correlatedIds)).toEqual(new Set([turnMetrics.turnId]));
    sendJSON(ws, { type: "_get_tts_count" });
    const ttsCount = (await waitForType(ws, "_tts_count")) as Record<
      string,
      unknown
    >;
    expect(ttsCount.count).toBe(1);

    for (const diagnostic of diagnostics) {
      const data = diagnostic.data as Record<string, unknown> | undefined;
      expect(JSON.stringify(data ?? {})).not.toContain("utterance 1");
      expect(Object.keys(data ?? {})).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /transcript|prompt|message|content|tool|argument|result|body|query|stack|token/i
          )
        ])
      );
      expect(diagnostic).toMatchObject({
        type: "diagnostic",
        event: expect.any(String),
        timestamp: expect.any(Number)
      });
    }

    ws.close();
  });

  it("starts aggregate streaming TTS only at the first provider call", async () => {
    const { ws } = await connectWS(uniqueDiagnosticPath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, {
      type: "_set_diagnostic_response_mode",
      value: "pending_multi"
    });
    await waitForAck(ws, "_set_diagnostic_response_mode");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const recording = recordVoiceEvents(ws);
    sendJSON(ws, { type: "text_message", text: "diagnose timing" });
    await waitForType(ws, "_turn_stream_pending");

    const beforeTextEvents = recording.events.flatMap((event) =>
      event !== "audio" && event.type === "diagnostic" ? [event.event] : []
    );
    expect(beforeTextEvents).toContain("model.started");
    expect(beforeTextEvents).not.toContain("model.first_text");
    expect(beforeTextEvents).not.toContain("tts.started");

    const turnEndedPromise = waitForMessageMatching(
      ws,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === "diagnostic" &&
        (message as Record<string, unknown>).event === "turn.ended"
    );
    const resolvedAckPromise = waitForAck(ws, "_resolve_turn_stream");
    sendJSON(ws, { type: "_resolve_turn_stream" });
    await Promise.all([resolvedAckPromise, turnEndedPromise]);
    recording.stop();

    const diagnostics = recording.events.flatMap((event) =>
      event !== "audio" && event.type === "diagnostic" ? [event] : []
    );
    const events = diagnostics.map((event) => event.event);
    expect(events.filter((event) => event === "tts.started")).toHaveLength(1);
    expect(events.indexOf("model.first_text")).toBeLessThan(
      events.indexOf("tts.started")
    );

    const started = diagnostics.find((event) => event.event === "tts.started");
    const completed = diagnostics.find(
      (event) => event.event === "tts.completed"
    );
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    const duration = (completed!.data as Record<string, unknown>).duration_ms;
    expect(duration).toEqual(expect.any(Number));
    expect(duration as number).toBeGreaterThanOrEqual(0);
    expect(
      Math.abs(
        (duration as number) -
          ((completed!.timestamp as number) - (started!.timestamp as number))
      )
    ).toBeLessThanOrEqual(10);

    sendJSON(ws, { type: "_get_tts_count" });
    const ttsCount = (await waitForType(ws, "_tts_count")) as Record<
      string,
      unknown
    >;
    expect(ttsCount.count).toBe(2);
    ws.close();
  });

  it("reports exposed reasoning before first visible text without content", async () => {
    const { ws } = await connectWS(uniqueDiagnosticPath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, {
      type: "_set_diagnostic_response_mode",
      value: "reasoning_stream"
    });
    await waitForAck(ws, "_set_diagnostic_response_mode");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const messagesPromise = collectMessagesUntil(
      ws,
      (message) =>
        message.type === "diagnostic" && message.event === "turn.ended"
    );
    sendJSON(ws, { type: "text_message", text: "reason about this" });
    const messages = await messagesPromise;
    const diagnostics = messages.filter(
      (message) => message.type === "diagnostic"
    );
    const events = diagnostics.map((message) => message.event);

    expect(
      events.filter((event) => event === "model.reasoning_started")
    ).toHaveLength(1);
    expect(
      events.filter((event) => event === "model.reasoning_completed")
    ).toHaveLength(1);
    expect(events.indexOf("model.reasoning_started")).toBeLessThan(
      events.indexOf("model.reasoning_completed")
    );
    expect(events.indexOf("model.reasoning_completed")).toBeLessThan(
      events.indexOf("model.first_text")
    );

    const reasoningCompleted = diagnostics.find(
      (message) => message.event === "model.reasoning_completed"
    );
    expect(reasoningCompleted?.data).toMatchObject({
      duration_ms: expect.any(Number),
      outcome: "completed",
      turn_id: expect.any(String)
    });
    expect(JSON.stringify(diagnostics)).not.toContain(
      "private reasoning content"
    );

    const turnIds = new Set(
      diagnostics
        .filter((message) =>
          /^(turn|model|tts|audio)\./.test(message.event as string)
        )
        .map(
          (message) =>
            (message.data as Record<string, unknown> | undefined)?.turn_id
        )
    );
    expect(turnIds.size).toBe(1);
    expect([...turnIds][0]).toEqual(expect.any(String));
    ws.close();
  });

  it("keeps replaced reasoning trackers correlated to their original turns", async () => {
    const { ws } = await connectWS(uniqueDiagnosticPath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, {
      type: "_set_diagnostic_response_mode",
      value: "pending_reasoning"
    });
    await waitForAck(ws, "_set_diagnostic_response_mode");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const recording = recordVoiceEvents(ws);
    sendJSON(ws, { type: "text_message", text: "first turn" });
    await waitForType(ws, "_reasoning_stream_pending");
    const firstReasoning = recording.events.find(
      (event) =>
        event !== "audio" &&
        event.type === "diagnostic" &&
        event.event === "model.reasoning_started"
    ) as Record<string, unknown>;
    const firstTurnId = (firstReasoning.data as Record<string, unknown>)
      .turn_id as string;

    sendJSON(ws, {
      type: "_set_diagnostic_response_mode",
      value: "string"
    });
    await waitForAck(ws, "_set_diagnostic_response_mode");
    const secondTurnMessagesPromise = collectMessagesUntil(
      ws,
      (message) =>
        message.type === "diagnostic" &&
        message.event === "turn.ended" &&
        (message.data as Record<string, unknown> | undefined)?.turn_id !==
          firstTurnId
    );
    sendJSON(ws, { type: "text_message", text: "second turn" });
    const secondTurnMessages = await secondTurnMessagesPromise;
    const secondStarted = secondTurnMessages.find(
      (message) =>
        message.type === "diagnostic" &&
        message.event === "turn.started" &&
        (message.data as Record<string, unknown> | undefined)?.turn_id !==
          firstTurnId
    );
    const secondTurnId = (
      secondStarted?.data as Record<string, unknown> | undefined
    )?.turn_id as string;
    expect(secondTurnId).toEqual(expect.any(String));
    expect(secondTurnId).not.toBe(firstTurnId);

    const oldReasoningCompleted = recording.events.filter(
      (event) =>
        event !== "audio" &&
        event.type === "diagnostic" &&
        event.event === "model.reasoning_completed" &&
        (event.data as Record<string, unknown> | undefined)?.turn_id ===
          firstTurnId
    );
    expect(oldReasoningCompleted).toHaveLength(1);
    expect(oldReasoningCompleted[0]).toMatchObject({
      data: { outcome: "aborted", turn_id: firstTurnId }
    });

    const oldTurnEndedPromise = waitForMessageMatching(
      ws,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === "diagnostic" &&
        (message as Record<string, unknown>).event === "turn.ended" &&
        ((message as Record<string, unknown>).data as Record<string, unknown>)
          .turn_id === firstTurnId
    );
    const resolvedAckPromise = waitForAck(ws, "_resolve_turn_stream");
    sendJSON(ws, { type: "_resolve_turn_stream" });
    await Promise.all([resolvedAckPromise, oldTurnEndedPromise]);
    recording.stop();

    const successorModelEvents = recording.events.filter(
      (event): event is Record<string, unknown> =>
        event !== "audio" &&
        event.type === "diagnostic" &&
        String(event.event).startsWith("model.") &&
        (event.data as Record<string, unknown> | undefined)?.turn_id ===
          secondTurnId
    );
    expect(successorModelEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "model.started",
        "model.first_text",
        "model.completed"
      ])
    );
    expect(
      successorModelEvents.some((event) =>
        String(event.event).startsWith("model.reasoning_")
      )
    ).toBe(false);
    ws.close();
  });

  it("does not start TTS when synthesis is skipped or the model has no output", async () => {
    const { ws } = await connectWS(uniqueDiagnosticPath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, { type: "_set_skip_synthesis", value: true });
    await waitForAck(ws, "_set_skip_synthesis");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const skippedMessagesPromise = collectMessagesUntil(
      ws,
      (message) =>
        message.type === "diagnostic" && message.event === "turn.ended"
    );
    sendJSON(ws, { type: "text_message", text: "skip synthesis" });
    const skippedMessages = await skippedMessagesPromise;
    const skippedEvents = skippedMessages.flatMap((message) =>
      message.type === "diagnostic" ? [message.event] : []
    );
    expect(skippedEvents).toContain("tts.skipped");
    expect(skippedEvents).not.toContain("tts.started");
    expect(skippedEvents).not.toContain("tts.completed");

    sendJSON(ws, { type: "_get_tts_count" });
    const skippedCount = (await waitForType(ws, "_tts_count")) as Record<
      string,
      unknown
    >;
    expect(skippedCount.count).toBe(0);
    ws.close();

    const { ws: emptyWs } = await connectWS(uniqueDiagnosticPath());
    await waitForStatus(emptyWs, "idle");
    sendJSON(emptyWs, {
      type: "_set_diagnostic_response_mode",
      value: "empty_stream"
    });
    await waitForAck(emptyWs, "_set_diagnostic_response_mode");
    sendJSON(emptyWs, { type: "start_call" });
    await waitForStatus(emptyWs, "listening");

    const emptyMessagesPromise = collectMessagesUntil(
      emptyWs,
      (message) =>
        message.type === "diagnostic" && message.event === "turn.ended"
    );
    sendJSON(emptyWs, { type: "text_message", text: "return no output" });
    const emptyMessages = await emptyMessagesPromise;
    const emptyEvents = emptyMessages.flatMap((message) =>
      message.type === "diagnostic" ? [message.event] : []
    );
    expect(emptyEvents).toContain("tts.skipped");
    expect(emptyEvents).not.toContain("tts.started");
    expect(emptyEvents).not.toContain("tts.completed");

    sendJSON(emptyWs, { type: "_get_tts_count" });
    const emptyCount = (await waitForType(emptyWs, "_tts_count")) as Record<
      string,
      unknown
    >;
    expect(emptyCount.count).toBe(0);
    emptyWs.close();
  });
});

describe("VoiceAgent — transcriber readiness", () => {
  it("does not send listening or run onCallStart before readiness resolves", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready");

    const audioConfig = waitForType(ws, "audio_config");
    sendJSON(ws, { type: "start_call" });
    await audioConfig;

    const beforeReady = collectMessagesUntil(
      ws,
      (msg) => msg.type === "_counts"
    );
    sendJSON(ws, { type: "_get_counts" });

    const beforeReadyMessages = await beforeReady;
    expect(beforeReadyMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(beforeReadyMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0
    });

    sendJSON(ws, { type: "_resolve_transcriber_ready" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.callStart).toBe(1);
    ws.close();
  });

  it("sends a visible error, returns idle, and cleans up when readiness rejects", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "reject_ready");

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
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(1);
      expect(failedCounts.keepAliveReleased).toBe(1);

      await setTranscriberMode(ws, "default");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(2);
      expect(restartedCounts.keepAliveReleased).toBe(1);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("ends only the active call when its ready transcriber reports a fatal runtime error", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "pending_ready");

      sendJSON(ws, { type: "start_call" });
      await waitForType(ws, "audio_config");
      sendJSON(ws, { type: "_resolve_transcriber_ready" });
      await waitForStatus(ws, "listening");

      const terminalMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, {
        type: "_report_transcriber_fatal",
        error: { message: "provider socket closed" }
      });
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
        component: "VoiceAgent",
        stage: "transcriber_runtime",
        message: "Speech recognition connection was lost",
        connectionId: expect.any(String),
        error: expect.objectContaining({
          name: "Error",
          message: "provider socket closed"
        })
      });

      sendJSON(ws, { type: "_get_counts" });
      const counts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(counts).toMatchObject({
        callStart: 1,
        callEnd: 1,
        keepAliveAcquired: 1,
        keepAliveReleased: 1
      });

      await setTranscriberMode(ws, "default");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("ignores a stale fatal callback from an earlier transcriber session", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "pending_ready");

      sendJSON(ws, { type: "start_call" });
      await waitForType(ws, "audio_config");
      sendJSON(ws, { type: "_resolve_transcriber_ready" });
      await waitForStatus(ws, "listening");
      sendJSON(ws, { type: "end_call" });
      await waitForStatus(ws, "idle");

      sendJSON(ws, { type: "start_call" });
      await waitForType(ws, "audio_config");
      sendJSON(ws, { type: "_resolve_transcriber_ready" });
      await waitForStatus(ws, "listening");

      const afterStalePromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "_counts"
      );
      sendJSON(ws, {
        type: "_report_transcriber_fatal_at",
        index: 0,
        error: new Error("stale session failure")
      });
      sendJSON(ws, { type: "_get_counts" });
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
        error: { message: "current session failure" }
      });
      const terminalMessages = await terminalMessagesPromise;
      expect(
        terminalMessages.filter((msg) => msg.type === "error")
      ).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "transcriber_runtime",
          error: expect.objectContaining({ message: "current session failure" })
        })
      );
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("logs structured readiness detail while preserving the generic client message", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "reject_ready_object");

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
      expect(errorLog).toHaveBeenCalledWith({
        component: "VoiceAgent",
        stage: "transcriber_startup",
        message: "Speech recognition failed to start",
        connectionId: expect.any(String),
        error: expect.objectContaining({
          name: "VoiceProviderError",
          message: "upstream unavailable",
          code: "provider_unavailable"
        })
      });
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when session creation throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "create_throw");

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
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const counts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(counts.callStart).toBe(0);
      expect(counts.callEnd).toBe(1);
      expect(counts.keepAliveAcquired).toBe(1);
      expect(counts.keepAliveReleased).toBe(1);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when beforeCallStart throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setBeforeCallStart(ws, "throw");

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Voice call failed to start"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(0);
      expect(failedCounts.keepAliveReleased).toBe(0);

      await setBeforeCallStart(ws, true);
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(1);
      expect(restartedCounts.keepAliveReleased).toBe(0);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when beforeCallStart rejects", async () => {
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setBeforeCallStart(ws, false);

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Voice call was rejected"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(0);
      expect(failedCounts.keepAliveReleased).toBe(0);

      await setBeforeCallStart(ws, true);
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(1);
      expect(restartedCounts.keepAliveReleased).toBe(0);
    } finally {
      ws.close();
    }
  });

  it("sends a visible error, returns idle, and cleans up when no transcriber is configured", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "missing");

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message:
          "No transcriber configured. Set 'transcriber' on your VoiceAgent subclass or override createTranscriber()."
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(0);
      expect(failedCounts.keepAliveReleased).toBe(0);

      await setTranscriberMode(ws, "default");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(1);
      expect(restartedCounts.keepAliveReleased).toBe(0);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when keepAlive rejects", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setKeepAliveThrow(ws, true);

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Voice call failed to start"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(0);
      expect(failedCounts.keepAliveReleased).toBe(0);

      await setKeepAliveThrow(ws, false);
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(1);
      expect(restartedCounts.keepAliveReleased).toBe(0);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("ignores stale readiness after end_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    const afterEnd = collectMessagesUntil(ws, (msg) => msg.type === "_counts");
    sendJSON(ws, { type: "_resolve_transcriber_ready" });
    sendJSON(ws, { type: "_get_counts" });
    const afterEndMessages = await afterEnd;

    expect(afterEndMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(afterEndMessages.some((msg) => msg.type === "error")).toBe(false);
    expect(afterEndMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0,
      callEnd: 1,
      keepAliveAcquired: 1,
      keepAliveReleased: 1
    });
    ws.close();
  });

  it("ignores stale readiness rejection after end_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready_no_close_settle");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    const afterEnd = collectMessagesUntil(ws, (msg) => msg.type === "_counts");
    sendJSON(ws, { type: "_reject_transcriber_ready" });
    await waitForMicrotasks();
    sendJSON(ws, { type: "_get_counts" });
    const afterEndMessages = await afterEnd;

    expect(afterEndMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(afterEndMessages.some((msg) => msg.type === "error")).toBe(false);
    expect(afterEndMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0,
      callEnd: 1,
      keepAliveAcquired: 1,
      keepAliveReleased: 1
    });
    ws.close();
  });

  it("ignores stale readiness rejection after a later startup succeeds", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready_no_close_settle");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    await setTranscriberMode(ws, "default");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const afterRestart = collectMessagesUntil(
      ws,
      (msg) => msg.type === "_counts"
    );
    sendJSON(ws, { type: "_reject_transcriber_ready_at", index: 0 });
    await waitForMicrotasks();
    sendJSON(ws, { type: "_get_counts" });
    const afterRestartMessages = await afterRestart;

    expect(afterRestartMessages.some((msg) => msg.type === "error")).toBe(
      false
    );
    expect(afterRestartMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 1,
      callEnd: 1,
      keepAliveAcquired: 2,
      keepAliveReleased: 1
    });
    ws.close();
  });

  it("ignores stale readiness rejection after disconnect", async () => {
    const path = uniquePath();
    const { ws } = await connectWS(path);
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready_no_close_settle");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    ws.close();
    await waitForMicrotasks();

    const { ws: nextWs } = await connectWS(path);
    await waitForStatus(nextWs, "idle");

    const afterDisconnect = collectMessagesUntil(
      nextWs,
      (msg) => msg.type === "_counts"
    );
    sendJSON(nextWs, { type: "_reject_transcriber_ready" });
    await waitForMicrotasks();
    sendJSON(nextWs, { type: "_get_counts" });
    const afterDisconnectMessages = await afterDisconnect;

    expect(afterDisconnectMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(afterDisconnectMessages.some((msg) => msg.type === "error")).toBe(
      false
    );
    expect(afterDisconnectMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0,
      keepAliveAcquired: 1,
      keepAliveReleased: 1
    });
    nextWs.close();
  });

  it("starts immediately for custom transcribers without waitUntilReady", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.callStart).toBe(1);
    ws.close();
  });
});

describe("VoiceAgent — continuous STT pipeline", () => {
  it("transcribes audio and echoes back via onTurn", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio to trigger utterance (20000 bytes)
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Wait for user transcript
    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    // Wait for assistant echo
    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect((transcriptEnd.text as string).includes("Echo:")).toBe(true);

    ws.close();
  });

  it("sends interim transcripts during audio streaming", async () => {
    const { ws } = await connectWS(uniquePath());
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

  it("clears interim transcript before emitting final", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Should get interim clear (empty text) before the user transcript
    const cleared = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_interim" &&
        (m as Record<string, unknown>).text === ""
    )) as Record<string, unknown>;
    expect(cleared.text).toBe("");

    ws.close();
  });

  it("sends pipeline metrics after processing", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const metrics = (await waitForType(ws, "metrics")) as Record<
      string,
      unknown
    >;
    expect(metrics).toHaveProperty("llm_ms");
    expect(metrics).toHaveProperty("tts_ms");
    expect(metrics).toHaveProperty("first_audio_ms");
    expect(metrics).toHaveProperty("total_ms");
    expect(metrics).not.toHaveProperty("vad_ms");
    expect(metrics).not.toHaveProperty("stt_ms");

    ws.close();
  });

  it("emits correlated stable speech metrics without changing legacy metrics", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const legacyPromise = waitForType(ws, "metrics");
    const turnMetricsPromise = waitForType(ws, "turn_metrics");
    for (let i = 0; i < 4; i++) ws.send(new ArrayBuffer(5000));

    const [legacy, turnMetrics] = (await Promise.all([
      legacyPromise,
      turnMetricsPromise
    ])) as [Record<string, unknown>, Record<string, unknown>];

    expect(Object.keys(legacy).sort()).toEqual([
      "first_audio_ms",
      "llm_ms",
      "total_ms",
      "tts_ms",
      "type"
    ]);
    expect(turnMetrics).toMatchObject({
      type: "turn_metrics",
      turnId: expect.any(String),
      source: "speech",
      outcome: "completed",
      turnTotalMs: expect.any(Number),
      speechStartToFirstInterimMs: expect.any(Number),
      speechStartToFinalMs: expect.any(Number),
      afterTranscribeMs: expect.any(Number),
      modelStreamConsumptionMs: expect.any(Number),
      finalInputToFirstAudioMs: expect.any(Number),
      ttsWallMs: expect.any(Number),
      ttsWorkMs: expect.any(Number)
    });
    expect(turnMetrics).not.toHaveProperty("finishReason");
    expect(turnMetrics).not.toHaveProperty("providerTurnIndex");
    expect(turnMetrics).not.toHaveProperty("endOfTurnConfidence");
    expect(turnMetrics).not.toHaveProperty("sentenceAttemptCount");
    expect(turnMetrics).not.toHaveProperty("visibleTextCharacterCount");
    expect(turnMetrics).not.toHaveProperty("audioByteCount");
    expect(JSON.stringify(turnMetrics)).not.toMatch(
      /utterance|Echo:|transcript|reasoning|tool|provider_body/
    );
    ws.close();
  });

  it("reports zero first-audio latency when a speech turn sends no audio", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_set_tts_mode", value: "no_audio" });
    await waitForAck(ws, "_set_tts_mode");

    const recording = recordVoiceEvents(ws);
    const metricsPromise = waitForType(ws, "metrics");
    const turnMetricsPromise = waitForType(ws, "turn_metrics");
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const [metrics, turnMetrics] = (await Promise.all([
      metricsPromise,
      turnMetricsPromise
    ])) as [Record<string, unknown>, Record<string, unknown>];
    expect(metrics.first_audio_ms).toBe(0);
    expect(turnMetrics).toMatchObject({ outcome: "completed" });
    expect(turnMetrics).not.toHaveProperty("finalInputToFirstAudioMs");
    expect(turnMetrics).not.toHaveProperty("ttsToFirstAudioMs");
    expect(statusAndAudioSequence(recording.events)).toEqual([
      "thinking",
      "listening"
    ]);

    recording.stop();
    ws.close();
  });

  it("reports overlapping metrics rather than additive stage durations", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_set_turn_delay", value: 50 });
    await waitForAck(ws, "_set_turn_delay");
    sendJSON(ws, { type: "_set_tts_mode", value: "pending" });
    await waitForAck(ws, "_set_tts_mode");

    const transcriptEndPromise = waitForType(ws, "transcript_end");
    const metricsPromise = waitForType(ws, "metrics");
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    await transcriptEndPromise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resolveAckPromise = waitForAck(ws, "_resolve_tts");
    sendJSON(ws, { type: "_resolve_tts" });

    const [metrics] = (await Promise.all([
      metricsPromise,
      resolveAckPromise
    ])) as [Record<string, unknown>, void];
    const llmMs = metrics.llm_ms as number;
    const ttsMs = metrics.tts_ms as number;
    const firstAudioMs = metrics.first_audio_ms as number;
    const totalMs = metrics.total_ms as number;

    expect(llmMs).toBeGreaterThan(0);
    expect(ttsMs).toBeGreaterThan(0);
    expect(firstAudioMs).toBeGreaterThanOrEqual(llmMs);
    expect(totalMs).toBeGreaterThanOrEqual(firstAudioMs);
    expect(totalMs).toBeLessThan(llmMs + ttsMs + firstAudioMs);

    ws.close();
  });

  it("keeps a transcribed string turn thinking until its first audio", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_set_tts_mode", value: "pending" });
    await waitForAck(ws, "_set_tts_mode");

    const recording = recordVoiceEvents(ws);
    const thinkingPromise = waitForStatus(ws, "thinking");
    const transcriptEndPromise = waitForType(ws, "transcript_end");
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    await Promise.all([thinkingPromise, transcriptEndPromise]);

    expect(statusAndAudioSequence(recording.events)).toEqual(["thinking"]);

    const speakingPromise = waitForStatus(ws, "speaking");
    const audioPromise = waitForBinary(ws);
    const listeningPromise = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_resolve_tts" });
    await Promise.all([speakingPromise, audioPromise, listeningPromise]);

    expect(statusAndAudioSequence(recording.events)).toEqual([
      "thinking",
      "speaking",
      "audio",
      "listening"
    ]);
    recording.stop();
    ws.close();
  });

  it("keeps an in-call streamed text turn thinking until its first audio", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_set_turn_response_mode", value: "stream" });
    await waitForAck(ws, "_set_turn_response_mode");
    sendJSON(ws, { type: "_set_tts_mode", value: "pending" });
    await waitForAck(ws, "_set_tts_mode");

    const recording = recordVoiceEvents(ws);
    const thinkingPromise = waitForStatus(ws, "thinking");
    const transcriptEndPromise = waitForType(ws, "transcript_end");
    sendJSON(ws, { type: "text_message", text: "Hello from text" });
    await Promise.all([thinkingPromise, transcriptEndPromise]);

    expect(statusAndAudioSequence(recording.events)).toEqual(["thinking"]);

    const speakingPromise = waitForStatus(ws, "speaking");
    const audioPromise = waitForBinary(ws);
    const listeningPromise = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_resolve_tts" });
    await Promise.all([speakingPromise, audioPromise, listeningPromise]);

    expect(statusAndAudioSequence(recording.events)).toEqual([
      "thinking",
      "speaking",
      "audio",
      "listening"
    ]);
    recording.stop();
    ws.close();
  });

  it("does not speak when TTS produces no audio", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_set_tts_mode", value: "no_audio" });
    await waitForAck(ws, "_set_tts_mode");

    const recording = recordVoiceEvents(ws);
    const listeningPromise = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "text_message", text: "Hello from text" });
    await listeningPromise;

    expect(statusAndAudioSequence(recording.events)).toEqual([
      "thinking",
      "listening"
    ]);
    recording.stop();
    ws.close();
  });

  it("does not speak when TTS fails before producing audio", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");

      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");
      sendJSON(ws, { type: "_set_tts_mode", value: "error" });
      await waitForAck(ws, "_set_tts_mode");

      const recording = recordVoiceEvents(ws);
      const listeningPromise = waitForStatus(ws, "listening");
      const turnMetricsPromise = waitForType(ws, "turn_metrics");
      sendJSON(ws, { type: "text_message", text: "Hello from text" });
      await listeningPromise;

      expect(statusAndAudioSequence(recording.events)).toEqual([
        "thinking",
        "listening"
      ]);
      expect(recording.events).toContainEqual({
        type: "error",
        message: "test TTS failed"
      });
      await expect(turnMetricsPromise).resolves.toMatchObject({
        source: "text",
        outcome: "tts_error"
      });
      recording.stop();
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("handles AI SDK stream responses that include tool calls", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    const mockResponse = [
      [
        { type: "text", text: "I can get the weather for you." },
        {
          type: "tool-call",
          toolName: "getWeather",
          input: { location: "San Francisco" },
          output: "warm"
        }
      ],
      [{ type: "text", text: "The weather is warm" }]
    ];
    sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "_ack" &&
        (m as Record<string, unknown>).command === "_set_mock_response"
    );

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(transcriptEnd.text).toBe(
      "I can get the weather for you. The weather is warm"
    );

    await waitForStatus(ws, "listening");
    ws.close();
  });

  it("reports an empty AI SDK stop finish as no_output", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_mock_response",
      response: [[{ type: "finish", finishReason: "stop" }]]
    });
    await waitForAck(ws, "_set_mock_response");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const terminalMessagesPromise = collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    const terminalMessages = await terminalMessagesPromise;

    expect(terminalMessages).toContainEqual({
      type: "completion_outcome",
      code: "no_output",
      stage: "llm",
      finishReason: "stop",
      partialOutput: false
    });
    ws.close();
  });

  it("reports an empty AI SDK content-filter finish as content_filtered", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_mock_response",
      response: [[{ type: "finish", finishReason: "content-filter" }]]
    });
    await waitForAck(ws, "_set_mock_response");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const terminalMessagesPromise = collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    const terminalMessages = await terminalMessagesPromise;

    expect(terminalMessages).toContainEqual({
      type: "completion_outcome",
      code: "content_filtered",
      stage: "llm",
      finishReason: "content-filter",
      partialOutput: false
    });
    ws.close();
  });

  it("reports an empty AI SDK length finish as output_limit", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_mock_response",
      response: [
        [
          {
            type: "finish",
            finishReason: "length",
            rawFinishReason: "max_tokens"
          }
        ]
      ]
    });
    await waitForAck(ws, "_set_mock_response");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const terminalMessagesPromise = collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    const terminalMessages = await terminalMessagesPromise;

    expect(terminalMessages).toContainEqual({
      type: "completion_outcome",
      code: "output_limit",
      stage: "llm",
      finishReason: "length",
      partialOutput: false
    });
    expect(terminalMessages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    ws.close();
  });

  it("reports an AI SDK error finish as model_error", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_mock_response",
      response: [[{ type: "finish", finishReason: "error" }]]
    });
    await waitForAck(ws, "_set_mock_response");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const terminalMessagesPromise = collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    const terminalMessages = await terminalMessagesPromise;

    expect(terminalMessages).toContainEqual({
      type: "completion_outcome",
      code: "model_error",
      stage: "llm",
      finishReason: "error",
      partialOutput: false
    });
    expect(terminalMessages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    ws.close();
  });

  it("keeps non-empty length output while reporting a partial output_limit", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_mock_response",
      response: [
        [
          { type: "text", text: "Truncated response." },
          { type: "finish", finishReason: "length" }
        ]
      ]
    });
    await waitForAck(ws, "_set_mock_response");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const audioPromise = waitForBinary(ws);
    const terminalMessagesPromise = collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    const [audio, terminalMessages] = await Promise.all([
      audioPromise,
      terminalMessagesPromise
    ]);

    expect(decodeAudio(audio)).toBe("Truncated response.");
    expect(terminalMessages).toContainEqual({
      type: "transcript_end",
      text: "Truncated response."
    });
    expect(terminalMessages).toContainEqual({
      type: "completion_outcome",
      code: "output_limit",
      stage: "llm",
      finishReason: "length",
      partialOutput: true
    });
    expect(terminalMessages.some((msg) => msg.type === "metrics")).toBe(true);
    expect(terminalMessages.some((msg) => msg.type === "error")).toBe(false);

    sendJSON(ws, { type: "_get_message_count" });
    const messageCount = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(messageCount.count).toBe(2);
    ws.close();
  });

  it("speaks stream text before delayed tool results complete", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    const mockResponse = [
      [
        { type: "text", text: "I can get the weather for you." },
        {
          type: "tool-call",
          toolName: "getWeather",
          input: { location: "San Francisco" },
          output: "warm",
          outputDelayMs: 3000
        }
      ],
      [{ type: "text", text: "The weather is warm" }]
    ];
    sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "_ack" &&
        (m as Record<string, unknown>).command === "_set_mock_response"
    );

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const audioPromise = waitForBinary(ws, 1000);
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const audio = await audioPromise;
    expect(decodeAudio(audio)).toBe("I can get the weather for you.");

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(transcriptEnd.text).toBe(
      "I can get the weather for you. The weather is warm"
    );

    await waitForStatus(ws, "listening");
    ws.close();
  });

  it("flushes partial stream speech before reporting stream errors", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    try {
      await waitForStatus(ws, "idle");

      const mockResponse = [
        [
          { type: "text", text: "Partial response." },
          { type: "error", message: "provider failed" }
        ]
      ];
      sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
      await waitForMessageMatching(
        ws,
        (m) =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).type === "_ack" &&
          (m as Record<string, unknown>).command === "_set_mock_response"
      );

      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      const audioPromise = waitForBinary(ws, 1000);
      const turnMetricsPromise = waitForType(ws, "turn_metrics");
      const terminalMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "listening"
      );
      for (let i = 0; i < 4; i++) {
        ws.send(new ArrayBuffer(5000));
      }

      const [audio, terminalMessages] = await Promise.all([
        audioPromise,
        terminalMessagesPromise
      ]);
      expect(decodeAudio(audio)).toBe("Partial response.");
      expect(
        terminalMessages.filter((msg) => msg.type === "transcript_end")
      ).toEqual([
        {
          type: "transcript_end",
          text: "Partial response."
        }
      ]);
      expect(
        terminalMessages.filter((msg) => msg.type === "completion_outcome")
      ).toEqual([
        {
          type: "completion_outcome",
          code: "model_error",
          stage: "llm",
          partialOutput: true
        }
      ]);
      expect(terminalMessages.filter((msg) => msg.type === "error")).toEqual([
        { type: "error", message: "provider failed" }
      ]);
      await expect(turnMetricsPromise).resolves.toMatchObject({
        source: "speech",
        outcome: "model_error"
      });
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("preserves string AI stream errors on the wire and in diagnostics", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    try {
      await waitForStatus(ws, "idle");

      sendJSON(ws, {
        type: "_set_mock_response",
        response: [
          [
            {
              type: "error",
              message: "ignored test label",
              asObject: true,
              cause: "provider unavailable"
            }
          ]
        ]
      });
      await waitForAck(ws, "_set_mock_response");

      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");
      for (let i = 0; i < 4; i++) {
        ws.send(new ArrayBuffer(5000));
      }

      const error = (await waitForType(ws, "error")) as Record<string, unknown>;
      expect(error.message).toBe("provider unavailable");
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "VoiceAgent",
          stage: "pipeline",
          error: expect.objectContaining({ message: "provider unavailable" })
        })
      );
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("does not inspect plain AI stream error objects", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    try {
      await waitForStatus(ws, "idle");

      sendJSON(ws, {
        type: "_set_mock_response",
        response: [
          [
            {
              type: "error",
              message: "ignored test label",
              asObject: true,
              cause: {
                code: "model_overloaded",
                error: { message: "provider unavailable" }
              }
            }
          ]
        ]
      });
      await waitForAck(ws, "_set_mock_response");

      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");
      for (let i = 0; i < 4; i++) {
        ws.send(new ArrayBuffer(5000));
      }

      const error = (await waitForType(ws, "error")) as Record<string, unknown>;
      expect(error.message).toBe("AI SDK stream error");
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "VoiceAgent",
          stage: "pipeline",
          error: expect.objectContaining({
            name: "Error",
            message: "AI SDK stream error"
          })
        })
      );
      const voiceLog = errorLog.mock.calls.find(
        ([record]) =>
          typeof record === "object" &&
          record !== null &&
          (record as Record<string, unknown>).component === "VoiceAgent"
      );
      expect(JSON.stringify(voiceLog)).not.toContain("provider unavailable");
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("uses the wire fallback without logging an Error cause payload", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    try {
      await waitForStatus(ws, "idle");

      sendJSON(ws, {
        type: "_set_mock_response",
        response: [
          [
            {
              type: "error",
              message: "[object Object]",
              cause: {
                code: 9999,
                error: {
                  message: "context window exceeded",
                  apiKey: "must-not-leak"
                }
              }
            }
          ]
        ]
      });
      await waitForAck(ws, "_set_mock_response");

      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");
      for (let i = 0; i < 4; i++) {
        ws.send(new ArrayBuffer(5000));
      }

      const error = (await waitForType(ws, "error")) as Record<string, unknown>;
      expect(error.message).toBe("Voice pipeline failed");
      expect(errorLog).toHaveBeenCalledWith({
        component: "VoiceAgent",
        stage: "pipeline",
        message: "Voice pipeline failed",
        connectionId: expect.any(String),
        error: expect.objectContaining({
          name: "Error",
          message: "[object Object]"
        })
      });
      const voiceLog = errorLog.mock.calls.find(
        ([record]) =>
          typeof record === "object" &&
          record !== null &&
          (record as Record<string, unknown>).component === "VoiceAgent"
      );
      expect(JSON.stringify(voiceLog)).not.toContain("context window exceeded");
      expect(JSON.stringify(voiceLog)).not.toContain("must-not-leak");
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("keeps deprecated AI SDK textStream support for tool-call streams", async () => {
    const { ws } = await connectWS(uniqueAISDKTextStreamPath());
    await waitForStatus(ws, "idle");

    const mockResponse = [
      [
        { type: "text", text: "I can get the weather for you." },
        {
          type: "tool-call",
          toolName: "getWeather",
          input: { location: "San Francisco" },
          output: "warm"
        }
      ],
      [{ type: "text", text: "The weather is warm" }]
    ];
    sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "_ack" &&
        (m as Record<string, unknown>).command === "_set_mock_response"
    );

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    // Known textStream bug: AI SDK textStream omits the boundary between
    // non-adjacent text parts separated by tool calls. Keep coverage so we
    // notice if deprecated textStream support stops working entirely.
    expect(transcriptEnd.text).toBe(
      "I can get the weather for you.The weather is warm"
    );

    await waitForStatus(ws, "listening");
    ws.close();
  });
});

describe("VoiceAgent — turn context history", () => {
  it("gives text turns completed history without the current transcript", async () => {
    const { ws } = await connectWS(uniqueContextPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "text_message", text: "first text turn" });
    const firstResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(firstResponse.text).toBe("[]");

    sendJSON(ws, { type: "text_message", text: "second text turn" });
    const secondResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(JSON.parse(secondResponse.text as string)).toEqual([
      { role: "user", content: "first text turn" },
      { role: "assistant", content: "[]" }
    ]);

    ws.close();
  });

  it("gives audio turns completed history without the current transcript", async () => {
    const { ws } = await connectWS(uniqueContextPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const firstResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(firstResponse.text).toBe("[]");
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const secondResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(JSON.parse(secondResponse.text as string)).toEqual([
      { role: "user", content: "utterance 1 (20000 bytes)" },
      { role: "assistant", content: "[]" }
    ]);

    ws.close();
  });
});

describe("VoiceAgent — agent context carryover", () => {
  it("feeds the assistant's spoken reply back to the transcriber session", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Wait for the assistant reply to finish and the pipeline to settle.
    await waitForType(ws, "transcript_end");
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_agent_context" });
    const ctx = (await waitForType(ws, "_agent_context")) as Record<
      string,
      unknown
    >;
    const contexts = ctx.contexts as string[];
    expect(contexts).toContain("Echo: utterance 1 (20000 bytes)");

    ws.close();
  });
});

describe("VoiceAgent — multi-turn", () => {
  it("handles second utterance after first pipeline completes", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // First utterance
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    );

    // Wait for pipeline to complete (back to listening)
    await waitForStatus(ws, "listening");

    // Second utterance (need another 20000 bytes, total 40000)
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect((transcript.text as string).includes("utterance 2")).toBe(true);

    ws.close();
  });

  it("persists conversation messages across turns", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Wait for full pipeline (user + assistant)
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    );

    await waitForStatus(ws, "listening");

    // Check message count
    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(2); // user + assistant

    ws.close();
  });
});

describe("VoiceAgent — interrupt", () => {
  it("aborts an active pipeline on model-detected speech start", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_set_turn_delay", value: 1000 });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "text_message", text: "long response" });
    await waitForStatus(ws, "thinking");

    const abortedMetricsPromise = waitForType(ws, "turn_metrics");
    ws.send(new ArrayBuffer(5000));

    const interrupt = (await waitForType(ws, "playback_interrupt")) as Record<
      string,
      unknown
    >;
    expect(interrupt).toEqual({ type: "playback_interrupt" });
    await waitForStatus(ws, "listening");
    await expect(abortedMetricsPromise).resolves.toMatchObject({
      source: "text",
      outcome: "aborted"
    });

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.interrupt).toBe(1);

    // The transcriber session stays alive after barge-in.
    for (let i = 0; i < 3; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;
    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    ws.close();
  });

  it("does not count model-detected speech as interrupt while already listening", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(5000));
    await waitForType(ws, "transcript_interim");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.interrupt).toBe(0);

    ws.close();
  });

  it("aborts pipeline on interrupt but session survives for next turn", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send some audio, then interrupt before utterance threshold
    const firstMetricsPromise = waitForType(ws, "turn_metrics");
    ws.send(new ArrayBuffer(10000));
    sendJSON(ws, { type: "interrupt" });
    await waitForStatus(ws, "listening");
    const firstMetrics = (await firstMetricsPromise) as Record<string, unknown>;
    expect(firstMetrics).toMatchObject({
      source: "speech",
      outcome: "aborted"
    });

    // Session should still be alive — send more audio to reach threshold
    const secondMetricsPromise = waitForType(ws, "turn_metrics");
    ws.send(new ArrayBuffer(10000));

    // Should still get a transcript because the session survived
    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect((transcript.text as string).includes("utterance 1")).toBe(true);
    const secondMetrics = (await secondMetricsPromise) as Record<
      string,
      unknown
    >;
    expect(secondMetrics).toMatchObject({
      source: "speech",
      outcome: "completed"
    });
    expect(secondMetrics.turnId).not.toBe(firstMetrics.turnId);

    ws.close();
  });

  it("counts interrupts", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "interrupt" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.interrupt).toBe(1);

    ws.close();
  });
});

describe("VoiceAgent — text messages", () => {
  it("reports empty out-of-call text completion outcomes", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_mock_response",
      response: [[{ type: "finish", finishReason: "length" }]]
    });
    await waitForAck(ws, "_set_mock_response");

    const turnMetricsPromise = waitForType(ws, "turn_metrics");
    const terminalMessagesPromise = collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "idle"
    );
    sendJSON(ws, { type: "text_message", text: "Answer in text" });
    const terminalMessages = await terminalMessagesPromise;

    expect(terminalMessages).toContainEqual({
      type: "completion_outcome",
      code: "output_limit",
      stage: "llm",
      finishReason: "length",
      partialOutput: false
    });
    expect(terminalMessages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    await expect(turnMetricsPromise).resolves.toMatchObject({
      source: "text",
      outcome: "output_limit"
    });
    ws.close();
  });

  it("flushes partial out-of-call text before a model-error outcome", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    try {
      await waitForStatus(ws, "idle");

      sendJSON(ws, {
        type: "_set_mock_response",
        response: [
          [
            { type: "text", text: "Partial text response." },
            { type: "error", message: "provider failed" }
          ]
        ]
      });
      await waitForAck(ws, "_set_mock_response");

      const turnMetricsPromise = waitForType(ws, "turn_metrics");
      const terminalMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "text_message", text: "Answer in text" });
      const terminalMessages = await terminalMessagesPromise;

      expect(terminalMessages).toContainEqual({
        type: "transcript_end",
        text: "Partial text response."
      });
      expect(
        terminalMessages.filter((msg) => msg.type === "completion_outcome")
      ).toEqual([
        {
          type: "completion_outcome",
          code: "model_error",
          stage: "llm",
          partialOutput: true
        }
      ]);
      expect(terminalMessages.filter((msg) => msg.type === "error")).toEqual([
        { type: "error", message: "provider failed" }
      ]);
      await expect(turnMetricsPromise).resolves.toMatchObject({
        source: "text",
        outcome: "model_error"
      });
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("reports empty in-call text completion outcomes", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_mock_response",
      response: [[{ type: "finish", finishReason: "content-filter" }]]
    });
    await waitForAck(ws, "_set_mock_response");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const turnMetricsPromise = waitForType(ws, "turn_metrics");
    const terminalMessagesPromise = collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );
    sendJSON(ws, { type: "text_message", text: "Answer during call" });
    const terminalMessages = await terminalMessagesPromise;

    expect(terminalMessages).toContainEqual({
      type: "completion_outcome",
      code: "content_filtered",
      stage: "llm",
      finishReason: "content-filter",
      partialOutput: false
    });
    expect(terminalMessages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    await expect(turnMetricsPromise).resolves.toMatchObject({
      source: "text",
      outcome: "content_filtered"
    });
    ws.close();
  });

  it("processes text messages through the pipeline", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const turnMetricsPromise = waitForType(ws, "turn_metrics");
    sendJSON(ws, { type: "text_message", text: "Hello from text" });

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect(transcript.text).toBe("Hello from text");

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(transcriptEnd.text).toBe("Echo: Hello from text");

    const turnMetrics = (await turnMetricsPromise) as Record<string, unknown>;
    expect(turnMetrics).toMatchObject({
      source: "text",
      outcome: "completed",
      modelStreamConsumptionMs: expect.any(Number)
    });
    expect(turnMetrics).not.toHaveProperty("speechStartToFirstInterimMs");
    expect(turnMetrics).not.toHaveProperty("speechStartToFinalMs");
    expect(turnMetrics).not.toHaveProperty("afterTranscribeMs");

    ws.close();
  });
});

describe("VoiceAgent — start_of_speech / end_of_speech are no-ops", () => {
  it("ignores start_of_speech and end_of_speech", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "start_of_speech" });
    sendJSON(ws, { type: "end_of_speech" });

    // Audio still flows to the continuous session
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect((transcript.text as string).includes("utterance 1")).toBe(true);
    ws.close();
  });
});

describe("VoiceAgent — forceEndCall", () => {
  it("programmatically ends a call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_force_end_call" });
    const msg = await waitForStatus(ws, "idle");
    expect(msg).toEqual({ type: "status", status: "idle" });

    ws.close();
  });
});

describe("VoiceAgent — edge cases", () => {
  it("audio sent before start_call is silently dropped", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    // Send audio before starting a call — should not crash
    ws.send(new ArrayBuffer(20000));

    // Now start a proper call — should work normally
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // Should only contain audio from after start_call (20000 bytes)
    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    ws.close();
  });

  it("double start_call is ignored when already in a call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(10000));

    // Duplicate start_call — should be silently ignored
    sendJSON(ws, { type: "start_call" });

    // Small delay to ensure the message was processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send more audio — session still alive from first start_call
    ws.send(new ArrayBuffer(10000));

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // Both chunks of audio (10000 + 10000 = 20000) reached the same session
    expect((transcript.text as string).includes("utterance 1")).toBe(true);
    expect((transcript.text as string).includes("20000")).toBe(true);

    ws.close();
  });
});

describe("VoiceAgent — call lifecycle counts", () => {
  it("tracks call start and end counts", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.callStart).toBe(1);
    expect(counts.callEnd).toBe(1);

    ws.close();
  });
});

// --- Empty response tests (uses TestEmptyResponseVoiceAgent) ---

let emptyInstanceCounter = 0;
function uniqueEmptyPath() {
  return `/agents/test-empty-response-voice-agent/empty-test-${++emptyInstanceCounter}`;
}

async function connectEmptyWS(path: string) {
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

describe("VoiceAgent — empty response handling", () => {
  it("does not emit assistant transcript events for an empty stream", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_response_mode",
      value: "empty_stream"
    });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const turnMetricsPromise = waitForType(ws, "turn_metrics");
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );

    expect(messages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    await expect(turnMetricsPromise).resolves.toMatchObject({
      source: "speech",
      outcome: "no_output"
    });
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("transcript_start");
    expect(types).not.toContain("transcript_end");
    expect(types).not.toContain("metrics");
    expect(messages).not.toContainEqual({
      type: "status",
      status: "speaking"
    });

    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(1);

    ws.close();
  });

  it("does not emit assistant transcript events for whitespace-only stream", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_response_mode",
      value: "whitespace_stream"
    });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );

    expect(messages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("transcript_start");
    expect(types).not.toContain("transcript_end");
    expect(types).not.toContain("metrics");

    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(1);

    ws.close();
  });

  it("defers assistant transcript start until streamed text is non-empty", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_response_mode",
      value: "leading_whitespace_stream"
    });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "transcript_end"
    );
    const assistantMessages = messages.filter((msg) =>
      ["transcript_start", "transcript_delta", "transcript_end"].includes(
        msg.type as string
      )
    );

    expect(assistantMessages).toEqual([
      { type: "transcript_start", role: "assistant" },
      { type: "transcript_delta", text: "   Hello" },
      { type: "transcript_delta", text: " world." },
      { type: "transcript_end", text: "   Hello world." }
    ]);

    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(2);

    ws.close();
  });

  it("sends error and does not save message when onTurn returns empty string", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio to trigger utterance
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Should get an error message about empty response without creating an
    // assistant transcript entry.
    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "error"
    );
    expect(messages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    expect(messages.map((m) => m.type)).not.toContain("transcript_start");
    expect(messages.map((m) => m.type)).not.toContain("transcript_end");
    expect(messages).not.toContainEqual({
      type: "status",
      status: "speaking"
    });

    // Should go back to listening
    await waitForStatus(ws, "listening");

    // Should NOT have saved any assistant message
    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    // Only the user message should be saved, not an empty assistant message
    expect(count.count).toBe(1);

    ws.close();
  });

  it("does not emit metrics for empty response", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Collect all messages until we get back to listening
    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );

    // Should NOT have received metrics
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("metrics");
    // Should have received an error
    expect(types).toContain("error");

    ws.close();
  });
});
