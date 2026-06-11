/**
 * Synthetic in-Worker client tests.
 *
 * Drives a `withVoice` agent end-to-end over the real wire protocol using
 * `HeadlessVoiceClient` — no browser APIs, entirely inside the Workers
 * runtime. This is the non-browser client path: raw PCM in, negotiated
 * audio frames out.
 *
 * Also covers the server-side format negotiation these clients depend on
 * (`preferred_format` honored, `sampleRate` advertised), which the browser
 * client never exercised.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HeadlessVoiceClient, type VoiceSocket } from "../headless-client";
import worker from "./worker";

// --- Helpers ---

let instanceCounter = 0;
function uniquePath() {
  return `/agents/test-voice-agent/headless-${++instanceCounter}`;
}

async function connect(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function newClient(
  ws: WebSocket,
  preferredFormat?: "mp3" | "pcm16" | "wav" | "opus"
) {
  return new HeadlessVoiceClient({
    socket: ws as unknown as VoiceSocket,
    preferredFormat
  });
}

/** Stream 20000 bytes of PCM (4 frames) — enough to trigger one utterance. */
async function streamOneUtterance(client: HeadlessVoiceClient) {
  await client.streamPcm(new ArrayBuffer(20000), { frameBytes: 5000 });
}

// --- Tests ---

describe("HeadlessVoiceClient — non-browser pipeline", () => {
  it("completes a full turn: PCM in, transcript + audio out", async () => {
    const ws = await connect(uniquePath());
    const client = newClient(ws, "pcm16");

    const config = await client.startCall();
    expect(config.format).toBe("pcm16");

    await client.waitForStatus("listening");
    await streamOneUtterance(client);

    const userText = await client.waitForTranscript("user");
    expect(userText).toContain("utterance 1");

    const assistantText = await client.waitForTranscript("assistant");
    expect(assistantText).toContain("Echo:");

    // The agent's TTS output arrives as a binary frame (TestTTS echoes
    // the text as bytes, so it is non-empty).
    const audio = await client.nextAudio();
    expect(audio.byteLength).toBeGreaterThan(0);

    client.close();
  });

  it("exposes negotiated format and sample rate", async () => {
    const ws = await connect(uniquePath());
    const client = newClient(ws, "pcm16");

    const config = await client.startCall();
    expect(config.format).toBe("pcm16");
    expect(config.sampleRate).toBe(16000);
    expect(client.audioConfig).toEqual({ format: "pcm16", sampleRate: 16000 });

    client.close();
  });

  it("drives a turn via a text message", async () => {
    const ws = await connect(uniquePath());
    const client = newClient(ws, "pcm16");
    await client.startCall();
    await client.waitForStatus("listening");

    client.sendText("hello there");

    const assistantText = await client.waitForTranscript("assistant");
    expect(assistantText).toContain("Echo: hello there");

    client.close();
  });

  it("returns to idle on end_call", async () => {
    const ws = await connect(uniquePath());
    const client = newClient(ws, "pcm16");
    await client.startCall();
    await client.waitForStatus("listening");

    client.endCall();
    await client.waitForStatus("idle");
    expect(client.status).toBe("idle");

    client.close();
  });

  it("records the welcome handshake", async () => {
    const ws = await connect(uniquePath());
    const client = newClient(ws, "pcm16");
    // welcome arrives right after connect; give the socket a tick to deliver.
    await client.startCall();
    expect(client.protocolVersion).toBe(1);

    client.close();
  });
});

describe("VoiceAgent — audio format negotiation", () => {
  it("honors a valid preferred_format", async () => {
    const ws = await connect(uniquePath());
    const client = newClient(ws, "wav");
    const config = await client.startCall();
    expect(config.format).toBe("wav");
    client.close();
  });

  it("falls back to the default when no format is requested", async () => {
    const ws = await connect(uniquePath());
    // Omit preferredFormat → client sends start_call without preferred_format.
    const client = newClient(ws);
    const config = await client.startCall();
    expect(config.format).toBe("mp3");
    expect(config.sampleRate).toBe(16000);
    client.close();
  });

  it("falls back to the default on an unknown format", async () => {
    const ws = await connect(uniquePath());
    // Send a bogus format directly on the wire.
    ws.send(JSON.stringify({ type: "hello", protocol_version: 1 }));
    ws.send(JSON.stringify({ type: "start_call", preferred_format: "flac" }));

    const format: string = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      ws.addEventListener("message", (e: MessageEvent) => {
        if (typeof e.data !== "string") return;
        const msg = JSON.parse(e.data);
        if (msg.type === "audio_config") {
          clearTimeout(timer);
          resolve(msg.format);
        }
      });
    });
    expect(format).toBe("mp3");
    ws.close();
  });
});
