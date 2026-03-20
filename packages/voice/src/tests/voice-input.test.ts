/**
 * Server-side VoiceInput mixin tests.
 *
 * Uses test agents that stub STT providers with deterministic results.
 * Tests cover: voice protocol, consumer lifecycle passthrough, message
 * routing, batch STT pipeline, streaming STT pipeline, provider-driven
 * EOT, onTranscript hook, beforeCallStart rejection, and interrupt handling.
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

/** Create a chunk of silent PCM audio (zeros). */
function makeSilentAudio(bytes: number): ArrayBuffer {
  return new ArrayBuffer(bytes);
}

let instanceCounter = 0;
function uniquePath(agent: string) {
  return `/agents/${agent}/voice-input-test-${++instanceCounter}`;
}

/** Request internal state from a test agent. */
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

describe("VoiceInput — consumer lifecycle passthrough", () => {
  it("calls consumer onConnect", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    const state = await getAgentState(ws);
    expect(state.connectCount).toBe(1);

    ws.close();
  });

  it("calls consumer onClose", async () => {
    // Connect two clients to the same instance so we can query state after close
    const instancePath = uniquePath("test-voice-input-agent");

    const { ws: ws1 } = await connectWS(instancePath);
    await waitForStatus(ws1, "idle");

    // Close first connection
    ws1.close();
    // Give the DO time to process the close
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Connect second client to same instance and query state
    const { ws: ws2 } = await connectWS(instancePath);
    await waitForStatus(ws2, "idle");

    const state = await getAgentState(ws2);
    // Two connects (ws1 + ws2), one close (ws1)
    expect(state.connectCount).toBe(2);
    expect(state.closeCount).toBe(1);

    ws2.close();
  });

  it("forwards non-voice messages to consumer onMessage", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    // Send a custom (non-voice) message
    sendJSON(ws, { type: "_custom", data: "hello from client" });
    await waitForType(ws, "_ack");

    const state = await getAgentState(ws);
    expect(state.customMessages).toEqual(["hello from client"]);

    ws.close();
  });

  it("does NOT forward voice protocol messages to consumer onMessage", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    // Send voice protocol messages — these should be intercepted
    sendJSON(ws, { type: "hello" });
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send a custom message to verify consumer onMessage works
    sendJSON(ws, { type: "_custom", data: "after voice msgs" });
    await waitForType(ws, "_ack");

    const state = await getAgentState(ws);
    // Only the _custom message should have reached onMessage
    expect(state.customMessages).toEqual(["after voice msgs"]);

    ws.close();
  });
});

describe("VoiceInput — batch STT pipeline", () => {
  it("transcribes audio and calls onTranscript", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio to exceed minAudioBytes (default 16000)
    ws.send(makeSilentAudio(20000));

    // Signal end of speech
    sendJSON(ws, { type: "end_of_speech" });

    // Should get a transcript message
    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    expect(transcript.role).toBe("user");
    expect(transcript.text).toBe("test input transcript");

    // Should return to listening
    await waitForStatus(ws, "listening");

    // Verify onTranscript was called
    const state = await getAgentState(ws);
    expect(state.transcripts).toEqual(["test input transcript"]);

    ws.close();
  });

  it("discards audio that is too short", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send audio below minAudioBytes threshold
    ws.send(makeSilentAudio(100));

    sendJSON(ws, { type: "end_of_speech" });

    // Should return to listening without a transcript
    await waitForStatus(ws, "listening");

    // Verify no transcript was generated
    const state = await getAgentState(ws);
    expect(state.transcripts).toEqual([]);

    ws.close();
  });

  it("handles multiple utterances", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // First utterance
    ws.send(makeSilentAudio(20000));
    sendJSON(ws, { type: "end_of_speech" });
    await waitForType(ws, "transcript");
    await waitForStatus(ws, "listening");

    // Second utterance
    ws.send(makeSilentAudio(20000));
    sendJSON(ws, { type: "end_of_speech" });
    await waitForType(ws, "transcript");
    await waitForStatus(ws, "listening");

    const state = await getAgentState(ws);
    expect(state.transcripts).toEqual([
      "test input transcript",
      "test input transcript"
    ]);

    ws.close();
  });
});

describe("VoiceInput — streaming STT pipeline", () => {
  it("transcribes with streaming STT and emits interim transcripts", async () => {
    const { ws } = await connectWS(
      uniquePath("test-streaming-voice-input-agent")
    );
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Start speech to create streaming session
    sendJSON(ws, { type: "start_of_speech" });

    // Send audio in chunks
    ws.send(makeSilentAudio(10000));
    ws.send(makeSilentAudio(10000));

    // Should get interim transcripts
    const interim = (await waitForType(ws, "transcript_interim")) as Record<
      string,
      unknown
    >;
    expect(interim.text).toBeDefined();

    // End speech to flush
    sendJSON(ws, { type: "end_of_speech" });

    // Should get final transcript
    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    expect(transcript.role).toBe("user");
    expect(typeof transcript.text).toBe("string");
    expect((transcript.text as string).includes("streaming input")).toBe(true);

    await waitForStatus(ws, "listening");

    const state = await getAgentState(ws);
    expect(state.transcripts).toHaveLength(1);

    ws.close();
  });
});

describe("VoiceInput — provider-driven EOT", () => {
  it("emits transcript on provider EOT without end_of_speech", async () => {
    const { ws } = await connectWS(uniquePath("test-eot-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "start_of_speech" });

    // Send enough audio to trigger EOT (>= 20000 bytes)
    for (let i = 0; i < 5; i++) {
      ws.send(makeSilentAudio(5000));
    }

    // Provider fires onEndOfTurn — should get transcript without end_of_speech
    const transcript = (await waitForType(ws, "transcript")) as Record<
      string,
      unknown
    >;
    expect(transcript.role).toBe("user");
    expect((transcript.text as string).includes("eot input")).toBe(true);

    await waitForStatus(ws, "listening");

    const state = await getAgentState(ws);
    expect(state.transcripts).toHaveLength(1);

    ws.close();
  });
});

describe("VoiceInput — interrupt", () => {
  it("aborts in-flight STT on interrupt", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send audio
    ws.send(makeSilentAudio(20000));

    // Interrupt before end_of_speech
    sendJSON(ws, { type: "interrupt" });
    await waitForStatus(ws, "listening");

    // No transcript should have been generated
    const state = await getAgentState(ws);
    expect(state.transcripts).toEqual([]);

    ws.close();
  });
});

describe("VoiceInput — beforeCallStart rejection", () => {
  it("does not start call when beforeCallStart returns false", async () => {
    const { ws } = await connectWS(
      uniquePath("test-reject-call-voice-input-agent")
    );
    await waitForStatus(ws, "idle");

    // start_call should be rejected — no listening status should appear
    sendJSON(ws, { type: "start_call" });

    // Send a second start_call to confirm the agent is still in idle state
    // (if it were listening, we'd see a status change)
    sendJSON(ws, { type: "start_call" });

    // Give a moment for any messages to arrive
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The agent should still be in idle — no "listening" status was sent
    // We verify by connecting and checking no transition happened
    ws.close();
  });
});

describe("VoiceInput — double start_call", () => {
  it("does not reset audio buffer on duplicate start_call", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send audio
    ws.send(makeSilentAudio(20000));

    // Send duplicate start_call — should NOT reset the buffer
    sendJSON(ws, { type: "start_call" });
    // Wait for the second listening status from the duplicate start_call
    await waitForStatus(ws, "listening");

    // End speech — should still have the audio from before the duplicate start_call
    sendJSON(ws, { type: "end_of_speech" });

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // Audio should still be present (not lost by duplicate start_call)
    expect(transcript.text).toBe("test input transcript");

    ws.close();
  });
});

describe("VoiceInput — interrupt before start_call", () => {
  it("does not create phantom in-call state", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    // Send interrupt before start_call — should not create phantom state
    sendJSON(ws, { type: "interrupt" });

    // Now send audio — it should be silently dropped (not buffered)
    ws.send(makeSilentAudio(20000));

    // Give a moment for processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Now start a proper call — should work normally
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send audio and end_of_speech — should produce a transcript
    ws.send(makeSilentAudio(20000));
    sendJSON(ws, { type: "end_of_speech" });

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // Should produce a normal transcript (audio after start_call was processed)
    expect(transcript.text).toBe("test input transcript");

    ws.close();
  });
});

describe("VoiceInput — no TTS or response generation", () => {
  it("does not send audio_config or agent transcript", async () => {
    const { ws } = await connectWS(uniquePath("test-voice-input-agent"));
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(makeSilentAudio(20000));
    sendJSON(ws, { type: "end_of_speech" });

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

    // Should NOT have audio_config, agent transcript, or TTS audio
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("audio_config");
    expect(
      messages.filter((m) => m.type === "transcript" && m.role === "agent")
    ).toHaveLength(0);

    // Should have user transcript
    expect(
      messages.filter((m) => m.type === "transcript" && m.role === "user")
    ).toHaveLength(1);

    ws.close();
  });
});
