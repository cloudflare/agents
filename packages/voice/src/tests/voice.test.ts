/**
 * Server-side VoiceAgent tests with continuous transcriber.
 *
 * Tests cover: voice protocol, continuous STT pipeline flow,
 * multi-turn conversation, interruption handling (session survives),
 * text messages, conversation persistence, and the beforeCallStart hook.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
  it("aborts pipeline on interrupt but session survives for next turn", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send some audio, then interrupt before utterance threshold
    ws.send(new ArrayBuffer(10000));
    sendJSON(ws, { type: "interrupt" });
    await waitForStatus(ws, "listening");

    // Session should still be alive — send more audio to reach threshold
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
  it("processes text messages through the pipeline", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

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
  it("sends error and does not save message when onTurn returns empty string", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio to trigger utterance
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Should get an error message about empty response
    const error = (await waitForType(ws, "error")) as Record<string, unknown>;
    expect(error.message).toBe("No response generated");

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
    const messages: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout collecting messages")),
        5000
      );
      const handler = (e: MessageEvent) => {
        if (typeof e.data === "string") {
          const msg = JSON.parse(e.data);
          messages.push(msg);
          if (msg.type === "status" && msg.status === "listening") {
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve();
          }
        }
      };
      ws.addEventListener("message", handler);
    });

    // Should NOT have received metrics
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("metrics");
    // Should have received an error
    expect(types).toContain("error");

    ws.close();
  });
});
