import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PlivoAdapter } from "../src/index.js";
import type { PlivoAdapterOptions } from "../src/index.js";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer
} from "../src/audio/utils.js";

// WebSocketPair and status 101 responses are Cloudflare Workers runtime APIs
// not available in Node/vitest. Stubs below let PlivoAdapter be unit-tested.

type Handler = (event: { data?: unknown }) => void;

class FakeWebSocket {
  readyState = 1; // OPEN
  sent: unknown[] = [];
  closed = false;
  private handlers = new Map<string, Handler[]>();

  accept() {}

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }

  addEventListener(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, payload?: { data?: unknown }) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload ?? {});
    }
  }

  get jsonSent(): Record<string, unknown>[] {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }

  get binarySent(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
}

let lastPair: { plivo: FakeWebSocket; server: FakeWebSocket } | null = null;

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>)["WebSocketPair"] =
    function (this: Record<number, FakeWebSocket>) {
      this[0] = new FakeWebSocket();
      this[1] = new FakeWebSocket();
      lastPair = { plivo: this[0], server: this[1] };
    };

  // Node's Response rejects status 101 (Workers-only). Patch it to accept
  // any status — what matters in tests is the WebSocket wiring, not the
  // status line.
  const OriginalResponse = globalThis.Response;
  (globalThis as unknown as Record<string, unknown>)["Response"] =
    class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        if (init?.status === 101) {
          super(body, { ...init, status: 200 });
        } else {
          super(body, init);
        }
      }
    };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Test-local G.711 mulaw reference codec ---
// Independent implementation of the spec algorithm, used to generate
// inbound payloads and verify outbound payloads against the adapter.

function muLawEncode(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (; exponent > 0; exponent--) {
    if (sample & 0x4000) break;
    sample <<= 1;
  }
  const mantissa = (sample >> 10) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawDecode(byte: number): number {
  const mu = ~byte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function pcmToMulawBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    bytes[i] = muLawEncode(samples[i]);
  }
  return arrayBufferToBase64(bytes.buffer as ArrayBuffer);
}

// --- Bridge harness ---

interface Harness {
  serverSocket: FakeWebSocket;
  agentSocket: FakeWebSocket;
  idFromNameCalls: string[];
  response: Response;
}

function createHarness(options?: PlivoAdapterOptions): Harness {
  const agentSocket = new FakeWebSocket();
  const idFromNameCalls: string[] = [];
  const env = {
    MyAgent: {
      idFromName(name: string) {
        idFromNameCalls.push(name);
        return name;
      },
      get() {
        return {
          fetch: async () => ({ webSocket: agentSocket })
        };
      }
    }
  };
  const request = new Request("https://example.com/plivo", {
    headers: { Upgrade: "websocket" }
  });
  const response = PlivoAdapter.handleRequest(request, env, "MyAgent", options);
  if (!lastPair) throw new Error("WebSocketPair was not constructed");
  return {
    serverSocket: lastPair.server,
    agentSocket,
    idFromNameCalls,
    response
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function startCall(
  harness: Harness,
  callId = "call-1",
  streamId = "stream-1"
) {
  harness.serverSocket.emit("message", {
    data: JSON.stringify({
      event: "start",
      sequenceNumber: 1,
      start: { callId, streamId, accountId: "acc-1", tracks: ["inbound"] }
    })
  });
  await tick();
}

function sendMedia(harness: Harness, samples: Int16Array, track = "inbound") {
  harness.serverSocket.emit("message", {
    data: JSON.stringify({
      event: "media",
      sequenceNumber: 2,
      streamId: "stream-1",
      media: {
        track,
        timestamp: "0",
        chunk: 1,
        payload: pcmToMulawBase64(samples)
      }
    })
  });
}

describe("PlivoAdapter.handleRequest", () => {
  it("returns 426 when request is not a WebSocket upgrade", () => {
    const request = new Request("https://example.com/plivo");
    const response = PlivoAdapter.handleRequest(request, {}, "MyAgent");
    expect(response.status).toBe(426);
  });

  it("accepts a WebSocket upgrade request", () => {
    const { response } = createHarness();
    // In Workers the status would be 101; the Response patch substitutes 200.
    expect(response.status).not.toBe(426);
    expect(response.status).not.toBeGreaterThanOrEqual(400);
  });

  it("connects to the agent and sends start_call on start", async () => {
    const harness = createHarness();
    await startCall(harness);
    expect(harness.agentSocket.jsonSent).toEqual([{ type: "start_call" }]);
  });

  it("uses the Plivo callId as the agent instance name by default", async () => {
    const harness = createHarness();
    await startCall(harness, "call-abc");
    expect(harness.idFromNameCalls).toEqual(["call-abc"]);
  });

  it("uses options.instanceName for the agent instance when given", async () => {
    const harness = createHarness({ instanceName: "shared" });
    await startCall(harness, "call-abc");
    expect(harness.idFromNameCalls).toEqual(["shared"]);
  });

  it("logs and survives a missing DO namespace", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = new Request("https://example.com/plivo", {
      headers: { Upgrade: "websocket" }
    });
    PlivoAdapter.handleRequest(request, {}, "MyAgent");
    if (!lastPair) throw new Error("WebSocketPair was not constructed");
    lastPair.server.emit("message", {
      data: JSON.stringify({
        event: "start",
        sequenceNumber: 1,
        start: { callId: "c", streamId: "s", accountId: "a", tracks: [] }
      })
    });
    await tick();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found in env")
    );
  });

  it("ignores binary frames and invalid JSON from Plivo", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.serverSocket.emit("message", { data: new ArrayBuffer(4) });
    harness.serverSocket.emit("message", { data: "not json" });
    // Only start_call so far; nothing crashed, nothing extra sent.
    expect(harness.agentSocket.sent).toHaveLength(1);
  });

  it("drops media that arrives before start", () => {
    const harness = createHarness();
    sendMedia(harness, new Int16Array(160));
    expect(harness.agentSocket.sent).toHaveLength(0);
  });

  it("ignores media on non-inbound tracks", async () => {
    const harness = createHarness();
    await startCall(harness);
    sendMedia(harness, new Int16Array(160), "outbound");
    expect(harness.agentSocket.binarySent).toHaveLength(0);
  });

  it("forwards dtmf events to the agent verbatim", async () => {
    const harness = createHarness();
    await startCall(harness);
    const dtmf = {
      event: "dtmf",
      sequenceNumber: 3,
      streamId: "stream-1",
      dtmf: { track: "inbound", digit: "5", timestamp: "100" }
    };
    harness.serverSocket.emit("message", { data: JSON.stringify(dtmf) });
    expect(harness.agentSocket.jsonSent).toContainEqual(dtmf);
  });

  it("sends end_call and closes the agent socket when Plivo disconnects", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.serverSocket.emit("close");
    expect(harness.agentSocket.jsonSent).toContainEqual({ type: "end_call" });
    expect(harness.agentSocket.closed).toBe(true);
  });

  it("closes the Plivo socket when the agent disconnects", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("close");
    expect(harness.serverSocket.closed).toBe(true);
  });
});

describe("inbound audio path (mulaw 8kHz → PCM 16kHz)", () => {
  it("decodes, upsamples, and forwards inbound audio to the agent", async () => {
    const harness = createHarness();
    await startCall(harness);
    sendMedia(harness, new Int16Array(160)); // 20ms of silence at 8kHz
    expect(harness.agentSocket.binarySent).toHaveLength(1);
    const pcm = new Int16Array(harness.agentSocket.binarySent[0]);
    expect(pcm).toHaveLength(320); // doubled by 8→16kHz resample
    expect(pcm.every((s) => s === 0)).toBe(true);
  });

  it("round-trips a constant tone within mulaw quantization error", async () => {
    const harness = createHarness();
    await startCall(harness);
    const amplitude = 10_000;
    sendMedia(harness, new Int16Array(160).fill(amplitude));
    const pcm = new Int16Array(harness.agentSocket.binarySent[0]);
    expect(pcm).toHaveLength(320);
    for (const sample of pcm) {
      expect(Math.abs(sample - amplitude)).toBeLessThan(300);
    }
  });
});

describe("outbound audio path (PCM 16kHz → mulaw 8kHz playAudio)", () => {
  it("downsamples, encodes, and wraps agent audio in playAudio", async () => {
    const harness = createHarness();
    await startCall(harness);
    const amplitude = 10_000;
    const pcm = new Int16Array(320).fill(amplitude);
    harness.agentSocket.emit("message", { data: pcm.buffer });

    const playAudio = harness.serverSocket.jsonSent.find(
      (m) => m.event === "playAudio"
    );
    expect(playAudio).toBeDefined();
    const media = playAudio?.media as {
      contentType: string;
      sampleRate: number;
      payload: string;
    };
    expect(media.contentType).toBe("audio/x-mulaw");
    expect(media.sampleRate).toBe(8000);

    const mulawBytes = new Uint8Array(base64ToArrayBuffer(media.payload));
    expect(mulawBytes).toHaveLength(160); // halved by 16→8kHz resample
    for (const byte of mulawBytes) {
      expect(Math.abs(muLawDecode(byte) - amplitude)).toBeLessThan(300);
    }
  });

  it("ignores agent audio that arrives before start", () => {
    const harness = createHarness();
    // Emit on a socket that was never connected — nothing should reach Plivo.
    harness.agentSocket.emit("message", { data: new ArrayBuffer(8) });
    expect(harness.serverSocket.jsonSent).toHaveLength(0);
  });
});

describe("agent JSON messages → Plivo checkpoints", () => {
  it("forwards transcript and status messages as checkpoint events", async () => {
    const harness = createHarness();
    await startCall(harness);
    const transcript = { type: "transcript", text: "hello" };
    harness.agentSocket.emit("message", { data: JSON.stringify(transcript) });

    const checkpoint = harness.serverSocket.jsonSent.find(
      (m) => m.event === "checkpoint"
    );
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.streamId).toBe("stream-1");
    expect(JSON.parse(checkpoint?.name as string)).toEqual(transcript);
  });

  it("ignores non-JSON agent messages", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", { data: "not json" });
    expect(harness.serverSocket.jsonSent).toHaveLength(0);
  });
});

describe("barge-in", () => {
  // Constant amplitude 1000 → mean squared energy 1,000,000, well above
  // the 250,000 speech threshold. Silence (zeros) stays below it.
  const loud = new Int16Array(160).fill(1000);
  const agentChunk = () => new Int16Array(320).fill(5000).buffer;
  const clearAudios = (h: Harness) =>
    h.serverSocket.jsonSent.filter((m) => m.event === "clearAudio");
  const playAudios = (h: Harness) =>
    h.serverSocket.jsonSent.filter((m) => m.event === "playAudio");

  // Mark the agent as actively speaking by forwarding one audio chunk
  // (emits a playAudio and arms the barge-in window).
  const speak = (h: Harness) =>
    h.agentSocket.emit("message", { data: agentChunk() });

  it("does not send clearAudio for silent inbound audio", async () => {
    const harness = createHarness();
    await startCall(harness);
    speak(harness);
    sendMedia(harness, new Int16Array(160));
    sendMedia(harness, new Int16Array(160));
    sendMedia(harness, new Int16Array(160));
    expect(clearAudios(harness)).toHaveLength(0);
  });

  it("does not barge in when the agent is not speaking", async () => {
    const harness = createHarness();
    await startCall(harness);
    // No agent audio sent — loud caller frames must NOT trigger clearAudio.
    for (let i = 0; i < 5; i++) sendMedia(harness, loud);
    expect(clearAudios(harness)).toHaveLength(0);
  });

  it("requires sustained speech (debounce) before barging in", async () => {
    const harness = createHarness();
    await startCall(harness);
    speak(harness);
    sendMedia(harness, loud);
    sendMedia(harness, loud);
    expect(clearAudios(harness)).toHaveLength(0); // 2 frames < debounce
    sendMedia(harness, loud);
    expect(clearAudios(harness)).toHaveLength(1); // 3rd frame fires once
  });

  it("does not re-fire clearAudio while still gated", async () => {
    const harness = createHarness();
    await startCall(harness);
    speak(harness);
    for (let i = 0; i < 6; i++) sendMedia(harness, loud);
    expect(clearAudios(harness)).toHaveLength(1);
  });

  it("still forwards inbound audio to the agent regardless of gating", async () => {
    const harness = createHarness();
    await startCall(harness);
    speak(harness);
    sendMedia(harness, loud);
    sendMedia(harness, loud);
    expect(harness.agentSocket.binarySent).toHaveLength(2);
  });

  it("holds stale audio until the agent confirms interruption", async () => {
    const harness = createHarness();
    await startCall(harness);
    speak(harness); // playAudio #1
    expect(playAudios(harness)).toHaveLength(1);
    for (let i = 0; i < 3; i++) sendMedia(harness, loud); // gate + clearAudio

    speak(harness);
    speak(harness);
    expect(playAudios(harness)).toHaveLength(1);

    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });
    expect(clearAudios(harness)).toHaveLength(1);

    speak(harness); // first audio from the new reply must be preserved
    expect(playAudios(harness)).toHaveLength(2);
  });

  it.each(["listening", "thinking"])(
    "releases the audio gate at the %s status boundary",
    async (status) => {
      const harness = createHarness();
      await startCall(harness);
      speak(harness);
      for (let i = 0; i < 3; i++) sendMedia(harness, loud);

      harness.agentSocket.emit("message", {
        data: JSON.stringify({ type: "status", status })
      });
      speak(harness);

      expect(playAudios(harness)).toHaveLength(2);
    }
  );

  it("requires a fresh burst to barge in again after un-gating", async () => {
    const harness = createHarness();
    await startCall(harness);
    speak(harness);
    for (let i = 0; i < 3; i++) sendMedia(harness, loud); // fires once
    expect(clearAudios(harness)).toHaveLength(1);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });
    speak(harness);
    // The debounce counter reset on the first fire, so a single loud frame
    // must NOT immediately re-fire while the agent resumes.
    sendMedia(harness, loud);
    expect(clearAudios(harness)).toHaveLength(1);
  });

  it("clears Plivo when the agent detects an interrupt", async () => {
    const harness = createHarness();
    await startCall(harness);
    speak(harness);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });
    expect(clearAudios(harness)).toHaveLength(1);
  });

  it("keeps barge-in armed for the duration of queued audio", async () => {
    const harness = createHarness();
    await startCall(harness);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Two seconds of 16kHz, 16-bit mono PCM, sent as one TTS sentence.
    harness.agentSocket.emit("message", {
      data: new Int16Array(32_000).fill(5000).buffer
    });
    vi.setSystemTime(1500);
    for (let i = 0; i < 3; i++) sendMedia(harness, loud);

    expect(clearAudios(harness)).toHaveLength(1);
  });
});
