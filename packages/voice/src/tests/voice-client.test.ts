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

  connect(): void {}

  start(): void {
    this.started = true;
  }

  stop(): void {
    if (this.stopped) throw new Error("source already stopped");
    this.stopped = true;
    this.onended?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  source: FakeAudioBufferSourceNode | null = null;
  deferDecode = false;
  pendingDecode: (() => void) | null = null;
  destination = {};

  async resume(): Promise<void> {}

  async close(): Promise<void> {}

  async decodeAudioData(_audioData: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.deferDecode) return {} as AudioBuffer;
    return new Promise((resolve) => {
      this.pendingDecode = () => resolve({} as AudioBuffer);
    });
  }

  createBufferSource(): AudioBufferSourceNode {
    this.source = new FakeAudioBufferSourceNode();
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

describe("VoiceClient playback interrupt", () => {
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
