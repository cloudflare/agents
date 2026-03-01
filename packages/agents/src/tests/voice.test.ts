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

describe("VoiceAgent — reconnect during call", () => {
  it("resumes call on new connection to same instance (simulates PartySocket reconnect)", async () => {
    // Use a fixed path so both connections hit the same DO instance
    const path = uniquePath();

    // First connection: start a call
    const { ws: ws1 } = await connectWS(path);
    await waitForStatus(ws1, "idle");
    sendJSON(ws1, { type: "start_call" });
    await waitForStatus(ws1, "listening");

    // Send some audio and get a transcript (proves call is working)
    ws1.send(new ArrayBuffer(20000));
    sendJSON(ws1, { type: "end_of_speech" });
    await waitForMessageMatching(
      ws1,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    );

    // Disconnect (simulates network drop)
    ws1.close();

    // Second connection: reconnect to the same instance
    const { ws: ws2 } = await connectWS(path);
    await waitForStatus(ws2, "idle");

    // Client would re-send start_call on reconnect
    sendJSON(ws2, { type: "start_call" });
    await waitForStatus(ws2, "listening");

    // Send audio on the new connection — should work normally
    ws2.send(new ArrayBuffer(20000));
    sendJSON(ws2, { type: "end_of_speech" });

    const transcript = (await waitForMessageMatching(
      ws2,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect(transcript.text).toBe("test transcript");
    ws2.close();
  });

  it("preserves conversation history across reconnect", async () => {
    const path = uniquePath();

    // First connection: have a conversation
    const { ws: ws1 } = await connectWS(path);
    await waitForStatus(ws1, "idle");
    sendJSON(ws1, { type: "start_call" });
    await waitForStatus(ws1, "listening");

    ws1.send(new ArrayBuffer(20000));
    sendJSON(ws1, { type: "end_of_speech" });

    // Wait for assistant response (conversation saved to SQLite)
    await waitForMessageMatching(
      ws1,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    );

    ws1.close();

    // Second connection: new call on the same instance
    const { ws: ws2 } = await connectWS(path);
    await waitForStatus(ws2, "idle");
    sendJSON(ws2, { type: "start_call" });
    await waitForStatus(ws2, "listening");

    // Send another turn
    ws2.send(new ArrayBuffer(20000));
    sendJSON(ws2, { type: "end_of_speech" });

    // Should still produce a response (history preserved in SQLite)
    const transcript = (await waitForMessageMatching(
      ws2,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcript.text).toBe("Echo: test transcript");
    ws2.close();
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

describe("VoiceAgent — beforeCallStart rejection", () => {
  it("does not transition to listening when beforeCallStart returns false", async () => {
    const path = uniquePath();
    const { ws } = await connectWS(path);
    await waitForStatus(ws, "idle");

    // Toggle beforeCallStart to false via a control message
    sendJSON(ws, { type: "_set_before_call_start", value: false });

    // Wait for the ack to ensure the flag is set
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "_ack"
    );

    // Now try to start a call — should be rejected silently
    sendJSON(ws, { type: "start_call" });

    // Prove the agent is still functional and in idle state:
    // send a text_message which should work and return idle (not listening)
    sendJSON(ws, { type: "text_message", text: "still idle" });

    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: still idle");

    // Should return to idle (not listening), proving start_call was rejected
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

  it("transitions to listening when beforeCallStart returns true (default)", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const msg = await waitForStatus(ws, "listening");
    expect(msg).toEqual({ type: "status", status: "listening" });
    ws.close();
  });
});

describe("VoiceAgent — audio_config", () => {
  it("sends audio_config message on start_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });

    // audio_config should arrive before listening status
    const config = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "audio_config"
    )) as Record<string, unknown>;

    expect(config.format).toBe("mp3");

    // listening should follow
    await waitForStatus(ws, "listening");
    ws.close();
  });
});

describe("VoiceAgent — format negotiation", () => {
  it("sends configured format even when client requests a different one", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    // Client requests pcm16, but the test agent is configured for mp3
    sendJSON(ws, { type: "start_call", preferred_format: "pcm16" });

    const config = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "audio_config"
    )) as Record<string, unknown>;

    // Server always sends its configured format
    expect(config.format).toBe("mp3");
    await waitForStatus(ws, "listening");
    ws.close();
  });

  it("sends configured format when client does not request one", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });

    const config = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "audio_config"
    )) as Record<string, unknown>;

    expect(config.format).toBe("mp3");
    await waitForStatus(ws, "listening");
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

// --- Streaming STT tests ---

/** Connect to the streaming STT test agent. */
async function connectStreamingWS(path: string) {
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

let streamingInstanceCounter = 0;
function uniqueStreamingPath() {
  return `/agents/test-streaming-voice-agent/streaming-test-${++streamingInstanceCounter}`;
}

/** Collect all messages matching a type until another message type arrives or timeout. */
function collectMessages(
  ws: WebSocket,
  type: string,
  timeout = 3000
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const collected: unknown[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(collected);
    }, timeout);
    const handler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === type) {
          collected.push(msg);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
    // Also resolve when we get a transcript (user) which means pipeline finished STT
    const doneHandler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "transcript" && msg.role === "user") {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          ws.removeEventListener("message", doneHandler);
          resolve(collected);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", doneHandler);
  });
}

describe("Streaming STT — basic pipeline", () => {
  it("produces transcript via streaming STT (no batch stt needed)", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio for minAudioBytes (> 16000)
    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

    // Wait for user transcript
    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // TestStreamingSTTSession.finish() returns "streaming transcript (N bytes)"
    expect(transcript.text).toBe("streaming transcript (20000 bytes)");
    ws.close();
  });

  it("sends transcript_interim messages during audio streaming", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Start collecting interim messages before sending audio
    const interimPromise = collectMessages(ws, "transcript_interim");

    // Send audio in multiple chunks to trigger interim callbacks
    ws.send(new ArrayBuffer(5000));
    ws.send(new ArrayBuffer(5000));
    ws.send(new ArrayBuffer(10000));
    sendJSON(ws, { type: "end_of_speech" });

    const interims = await interimPromise;

    // Should have received at least one interim message
    expect(interims.length).toBeGreaterThan(0);

    // Each interim should have a text field
    for (const interim of interims) {
      expect(interim).toHaveProperty("type", "transcript_interim");
      expect(interim).toHaveProperty("text");
    }

    ws.close();
  });

  it("returns assistant response after streaming STT", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

    // Wait for assistant transcript_end
    const transcriptEnd = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    )) as Record<string, unknown>;

    expect(transcriptEnd.text).toBe("Echo: streaming transcript (20000 bytes)");
    ws.close();
  });

  it("sends pipeline metrics after streaming STT processing", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

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

    // STT should be very fast — it's just a flush, not full transcription
    expect(metrics.stt_ms).toBeLessThan(100);

    ws.close();
  });
});

describe("Streaming STT — start_of_speech", () => {
  it("handles explicit start_of_speech message", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Explicitly signal speech start (like new VoiceClient would)
    sendJSON(ws, { type: "start_of_speech" });

    // Send audio
    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect(transcript.text).toBe("streaming transcript (20000 bytes)");
    ws.close();
  });

  it("auto-creates session without start_of_speech (backward compat)", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // No start_of_speech — just send audio directly (old client behavior)
    ws.send(new ArrayBuffer(20000));
    sendJSON(ws, { type: "end_of_speech" });

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // Should still work — session auto-created on first audio chunk
    expect(transcript.text).toBe("streaming transcript (20000 bytes)");
    ws.close();
  });
});

describe("Streaming STT — interruption", () => {
  it("aborts streaming STT session on interrupt", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send audio to create a session
    ws.send(new ArrayBuffer(20000));

    // Interrupt before end_of_speech
    sendJSON(ws, { type: "interrupt" });

    // Should return to listening
    const listeningStatus = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "status" &&
        (m as Record<string, unknown>).status === "listening"
    )) as Record<string, unknown>;

    expect(listeningStatus.status).toBe("listening");

    // Now send new audio — should create a fresh session and work normally
    ws.send(new ArrayBuffer(25000));
    sendJSON(ws, { type: "end_of_speech" });

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect(transcript.text).toBe("streaming transcript (25000 bytes)");
    ws.close();
  });

  it("aborts streaming STT session on end_call", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(20000));

    sendJSON(ws, { type: "end_call" });

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
});

describe("Streaming STT — short audio rejection", () => {
  it("aborts session and returns to listening on short audio", async () => {
    const { ws } = await connectStreamingWS(uniqueStreamingPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send very short audio (< minAudioBytes = 16000)
    ws.send(new ArrayBuffer(100));
    sendJSON(ws, { type: "end_of_speech" });

    // Should get listening status back (session aborted, no processing)
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
});
