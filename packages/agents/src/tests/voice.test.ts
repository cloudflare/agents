/**
 * Server-side VoiceAgent tests.
 *
 * Uses a TestVoiceAgent that stubs STT/TTS/VAD with deterministic results.
 * Tests cover: voice protocol, pipeline flow, conversation persistence,
 * interruption handling, text messages, and the beforeCallStart hook.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import worker from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

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

/** Collect messages until we find one matching the predicate, or timeout. */
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

// Use unique instance names to avoid interference between tests
let instanceCounter = 0;
function uniquePath() {
  return `/agents/test-voice-agent/voice-test-${++instanceCounter}`;
}

// --- Tests ---

/** Wait for a voice status message with a specific status value. */
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

describe("VoiceAgent — protocol", () => {
  it("sends idle status on connect", async () => {
    const { ws } = await connectWS(uniquePath());
    // Agent base class sends cf_agent_identity and cf_agent_mcp_servers first;
    // wait specifically for the voice idle status.
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
});

describe("VoiceAgent — audio pipeline", () => {
  it("processes audio and returns user transcript on end_of_speech", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio data (> minAudioBytes = 16000)
    ws.send(new ArrayBuffer(20000));

    // Trigger end of speech
    sendJSON(ws, { type: "end_of_speech" });

    // Wait for the user transcript message
    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect(transcript.text).toBe("test transcript");
    ws.close();
  });

  it("returns assistant response after processing", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

    // Wait for the assistant transcript_end
    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: test transcript");
    ws.close();
  });

  it("sends pipeline metrics after processing", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

    // Wait for metrics
    const metrics = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "metrics"
    )) as Record<string, unknown>;

    expect(metrics).toHaveProperty("vad_ms");
    expect(metrics).toHaveProperty("stt_ms");
    expect(metrics).toHaveProperty("llm_ms");
    expect(metrics).toHaveProperty("tts_ms");
    expect(metrics).toHaveProperty("first_audio_ms");
    expect(metrics).toHaveProperty("total_ms");

    ws.close();
  });
});

describe("VoiceAgent — text messages", () => {
  it("handles text_message without an active call (text-only response)", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "text_message", text: "hello" });

    // Wait for the assistant transcript_end
    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: hello");

    // Should end with idle status (not listening, since no call is active)
    const idleStatus = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "status" &&
        (m as Record<string, unknown>).status === "idle"
    )) as Record<string, unknown>;

    expect(idleStatus.status).toBe("idle");
    ws.close();
  });

  it("ignores text_message with missing text field", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    // Send text_message without text field — should not crash
    sendJSON(ws, { type: "text_message" });

    // Prove connection is still alive by sending a valid message
    sendJSON(ws, { type: "text_message", text: "alive" });

    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: alive");
    ws.close();
  });

  it("ignores empty text_message", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "text_message", text: "" });

    // Prove connection is still alive
    sendJSON(ws, { type: "text_message", text: "still works" });

    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: still works");
    ws.close();
  });
});

describe("VoiceAgent — interruption", () => {
  it("returns to listening status after interrupt", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send audio and trigger pipeline
    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

    // Immediately interrupt
    sendJSON(ws, { type: "interrupt" });

    // Should eventually return to listening
    const listeningStatus = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "status" &&
        (m as Record<string, unknown>).status === "listening"
    )) as Record<string, unknown>;

    expect(listeningStatus.status).toBe("listening");
    ws.close();
  });
});

describe("VoiceAgent — non-voice messages", () => {
  it("does not crash on unknown JSON message types", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    // Send a custom message type
    sendJSON(ws, { type: "custom_event", data: "hello" });

    // Prove connection is still alive
    sendJSON(ws, { type: "text_message", text: "still alive" });

    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: still alive");
    ws.close();
  });

  it("does not crash on non-JSON string messages", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    // Send non-JSON text
    ws.send("this is not json {{{");

    // Prove connection is still alive
    sendJSON(ws, { type: "text_message", text: "works" });

    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: works");
    ws.close();
  });
});

describe("VoiceAgent — audio buffer limits", () => {
  it("does not process audio shorter than minAudioBytes", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send very short audio (less than 16000 bytes)
    ws.send(new ArrayBuffer(100));
    sendJSON(ws, { type: "end_of_speech" });

    // Should get listening status back (not thinking/processing)
    const msg = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "status" &&
        (m as Record<string, unknown>).status === "listening"
    )) as Record<string, unknown>;

    expect(msg.status).toBe("listening");
    ws.close();
  });

  it("ignores audio chunks when not in a call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    // Send audio without start_call — should be silently ignored
    ws.send(new ArrayBuffer(20000));

    // Prove connection is still alive
    sendJSON(ws, { type: "text_message", text: "alive" });

    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: alive");
    ws.close();
  });
});
