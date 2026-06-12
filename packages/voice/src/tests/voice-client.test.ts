import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceClient } from "../voice-client";
import type { VoiceAudioInput, VoiceTransport } from "../types";

class MockTransport implements VoiceTransport {
  sentJSON: Record<string, unknown>[] = [];
  sentBinary: ArrayBuffer[] = [];
  connected = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  sendJSON(data: Record<string, unknown>): void {
    this.sentJSON.push(data);
  }

  sendBinary(data: ArrayBuffer): void {
    this.sentBinary.push(data);
  }

  connect(): void {
    this.connected = true;
    this.onopen?.();
  }

  disconnect(): void {
    this.connected = false;
    this.onclose?.();
  }

  receive(data: string | ArrayBuffer | Blob): void {
    this.onmessage?.(data);
  }
}

class FakeAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  stopped = false;
  started = false;
  startedAt: number | null = null;

  connect(): void {}

  start(when?: number): void {
    this.started = true;
    this.startedAt = when ?? null;
  }

  stop(): void {
    if (this.stopped) throw new Error("source already stopped");
    this.stopped = true;
    this.onended?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  source: FakeAudioBufferSourceNode | null = null;
  sources: FakeAudioBufferSourceNode[] = [];
  deferDecode = false;
  pendingDecode: (() => void) | null = null;
  destination = {};

  async resume(): Promise<void> {}

  async close(): Promise<void> {}

  async decodeAudioData(_audioData: ArrayBuffer): Promise<AudioBuffer> {
    const decoded = { duration: 0.5 } as AudioBuffer;
    if (!this.deferDecode) return decoded;
    return new Promise((resolve) => {
      this.pendingDecode = () => resolve(decoded);
    });
  }

  createBuffer(
    _channels: number,
    length: number,
    sampleRate: number
  ): AudioBuffer {
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length)
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    this.source = new FakeAudioBufferSourceNode();
    this.sources.push(this.source);
    return this.source as unknown as AudioBufferSourceNode;
  }
}

class FakeAudioInput implements VoiceAudioInput {
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData: ((pcm: ArrayBuffer) => void) | null = null;
  started = false;
  stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

let originalAudioContext: typeof AudioContext | undefined;
let audioContext: FakeAudioContext;

async function waitForSource(): Promise<FakeAudioBufferSourceNode> {
  for (let i = 0; i < 10; i++) {
    if (audioContext.source) return audioContext.source;
    await Promise.resolve();
  }
  throw new Error("expected audio source to be created");
}

async function waitForSourceCount(
  count: number
): Promise<FakeAudioBufferSourceNode[]> {
  for (let i = 0; i < 20; i++) {
    if (audioContext.sources.length >= count) return audioContext.sources;
    await Promise.resolve();
  }
  throw new Error(
    `expected ${count} audio sources, got ${audioContext.sources.length}`
  );
}

beforeEach(() => {
  originalAudioContext = globalThis.AudioContext;
  audioContext = new FakeAudioContext();
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: class {
      constructor() {
        return audioContext;
      }
    }
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: originalAudioContext
  });
});

describe("VoiceClient playback interrupt", () => {
  it("stops active playback when the server sends playback_interrupt", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    transport.receive(new ArrayBuffer(4));

    const source = await waitForSource();
    expect(source.stopped).toBe(false);

    transport.receive(JSON.stringify({ type: "playback_interrupt" }));
    expect(() =>
      transport.receive(JSON.stringify({ type: "playback_interrupt" }))
    ).not.toThrow();

    expect(source.stopped).toBe(true);
  });

  it("does not start playback if interrupted while audio is decoding", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    audioContext.deferDecode = true;

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await Promise.resolve();

    expect(audioContext.pendingDecode).toBeDefined();
    transport.receive(JSON.stringify({ type: "playback_interrupt" }));
    audioContext.pendingDecode?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContext.source).toBeNull();
  });

  it("does not start playback if client-side interrupt fires while audio is decoding", async () => {
    const transport = new MockTransport();
    const audioInput = new FakeAudioInput();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput,
      interruptThreshold: 0.1,
      interruptChunks: 1
    });
    audioContext.deferDecode = true;

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    await client.startCall();
    expect(audioInput.started).toBe(true);

    transport.receive(new ArrayBuffer(4));
    await Promise.resolve();

    expect(audioContext.pendingDecode).toBeDefined();
    audioInput.onAudioLevel?.(0.2);
    expect(transport.sentJSON).toContainEqual({ type: "interrupt" });

    audioContext.pendingDecode?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContext.source).toBeNull();
  });

  it("does not start playback if call ends while audio is decoding", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    audioContext.deferDecode = true;

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await Promise.resolve();

    expect(audioContext.pendingDecode).toBeDefined();
    client.endCall();
    expect(transport.sentJSON).toContainEqual({ type: "end_call" });

    audioContext.pendingDecode?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContext.source).toBeNull();
  });

  it("does not start playback if client disconnects while audio is decoding", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    audioContext.deferDecode = true;

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await Promise.resolve();

    expect(audioContext.pendingDecode).toBeDefined();
    client.disconnect();
    expect(transport.connected).toBe(false);

    audioContext.pendingDecode?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContext.source).toBeNull();
  });
});

describe("VoiceClient gapless playback", () => {
  // 1600 samples of 16-bit PCM = 0.1s at 16kHz
  function pcm16Chunk(): ArrayBuffer {
    return new ArrayBuffer(1600 * 2);
  }

  function startPcm16Call(): { transport: MockTransport; client: VoiceClient } {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    client.connect();
    transport.receive(
      JSON.stringify({ type: "audio_config", format: "pcm16" })
    );
    return { transport, client };
  }

  it("schedules consecutive chunks back-to-back instead of waiting for ended", async () => {
    const { transport } = startPcm16Call();
    audioContext.currentTime = 5;

    transport.receive(pcm16Chunk());
    transport.receive(pcm16Chunk());
    const sources = await waitForSourceCount(2);

    // The second chunk is scheduled while the first is still playing,
    // starting exactly where the first ends on the audio clock.
    expect(sources[0].startedAt).toBe(5);
    expect(sources[0].stopped).toBe(false);
    expect(sources[1].startedAt).toBeCloseTo(5.1, 10);
  });

  it("starts at the current time when playback has fallen behind the cursor", async () => {
    const { transport } = startPcm16Call();
    audioContext.currentTime = 5;
    transport.receive(pcm16Chunk());
    await waitForSourceCount(1);

    audioContext.currentTime = 7; // well past the first chunk's end
    transport.receive(pcm16Chunk());
    const sources = await waitForSourceCount(2);

    expect(sources[1].startedAt).toBe(7);
  });

  it("stops every scheduled chunk on playback_interrupt", async () => {
    const { transport } = startPcm16Call();
    transport.receive(pcm16Chunk());
    transport.receive(pcm16Chunk());
    transport.receive(pcm16Chunk());
    const sources = await waitForSourceCount(3);

    transport.receive(JSON.stringify({ type: "playback_interrupt" }));

    expect(sources.every((source) => source.stopped)).toBe(true);
  });

  it("still treats playback as active after the queue drains, so a user transcript interrupts the scheduled tail", async () => {
    const { transport } = startPcm16Call();
    transport.receive(pcm16Chunk());
    transport.receive(pcm16Chunk());
    const sources = await waitForSourceCount(2);

    transport.receive(
      JSON.stringify({ type: "transcript", role: "user", text: "hold on" })
    );

    expect(sources.every((source) => source.stopped)).toBe(true);
  });

  it("resets the playback cursor when a call ends", async () => {
    const { transport, client } = startPcm16Call();
    audioContext.currentTime = 5;
    transport.receive(pcm16Chunk());
    await waitForSourceCount(1);

    client.endCall();
    audioContext.currentTime = 2;
    transport.receive(pcm16Chunk());
    const sources = await waitForSourceCount(2);

    // Without the reset this would start at the stale 5.1 cursor.
    expect(sources[1].startedAt).toBe(2);
  });
});
