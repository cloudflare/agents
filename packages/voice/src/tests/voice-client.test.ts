import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  connectedTo: unknown = null;

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

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
  mediaStreamDestination = { stream: {} };

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

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return this
      .mediaStreamDestination as unknown as MediaStreamAudioDestinationNode;
  }
}

class FakeAudioElement {
  autoplay = false;
  srcObject: MediaStream | null = null;
  paused = false;
  playCount = 0;
  rejectPlay = false;
  rejectSinkId = false;
  sinkIds: string[] = [];

  async play(): Promise<void> {
    this.playCount++;
    if (this.rejectPlay) throw new Error("play rejected");
  }

  pause(): void {
    this.paused = true;
  }

  async setSinkId(sinkId: string): Promise<void> {
    this.sinkIds.push(sinkId);
    if (this.rejectSinkId) throw new Error("setSinkId rejected");
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
let originalAudio: typeof Audio | undefined;
let audioContext: FakeAudioContext;
let audioElement: FakeAudioElement;

async function waitForConnectedSource(): Promise<FakeAudioBufferSourceNode> {
  for (let i = 0; i < 10; i++) {
    if (audioContext.source?.connectedTo) return audioContext.source;
    await Promise.resolve();
  }
  throw new Error("expected audio source to be connected");
}

describe("VoiceClient playback interrupt", () => {
  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    originalAudio = globalThis.Audio;
    audioContext = new FakeAudioContext();
    audioElement = new FakeAudioElement();
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: class {
        constructor() {
          return audioContext;
        }
      }
    });
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: class {
        constructor() {
          return audioElement;
        }
      }
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: originalAudioContext
    });
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: originalAudio
    });
  });

  it("stops active playback when the server sends playback_interrupt", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    transport.receive(new ArrayBuffer(4));

    const source = await waitForConnectedSource();
    expect(source.stopped).toBe(false);
    expect(source.connectedTo).toBe(audioContext.mediaStreamDestination);
    expect(audioElement.srcObject).toBe(
      audioContext.mediaStreamDestination.stream
    );
    expect(audioElement.playCount).toBe(1);
    expect(audioElement.sinkIds).toEqual(["default"]);

    transport.receive(JSON.stringify({ type: "playback_interrupt" }));
    expect(() =>
      transport.receive(JSON.stringify({ type: "playback_interrupt" }))
    ).not.toThrow();

    expect(source.stopped).toBe(true);
  });

  it("releases the HTML audio playback output when the call ends", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));

    await waitForConnectedSource();
    client.endCall();

    expect(audioElement.paused).toBe(true);
    expect(audioElement.srcObject).toBeNull();
  });

  it("applies the configured output device to assistant playback", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "speaker-1"
    });

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));

    await waitForConnectedSource();

    expect(audioElement.sinkIds).toEqual(["speaker-1"]);
  });

  it("updates the output device without reconnecting playback", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "speaker-1"
    });

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await waitForConnectedSource();

    await client.setOutputDevice("speaker-2");
    await client.setOutputDevice();

    expect(audioElement.sinkIds).toEqual(["speaker-1", "speaker-2", "default"]);
  });

  it("reports output device failures without stopping playback", async () => {
    const transport = new MockTransport();
    const errors: Array<string | null> = [];
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "missing-speaker"
    });
    audioElement.rejectSinkId = true;
    client.addEventListener("error", (error) => errors.push(error));

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));

    const source = await waitForConnectedSource();

    expect(source.connectedTo).toBe(audioContext.mediaStreamDestination);
    expect(audioElement.playCount).toBe(1);
    expect(audioElement.sinkIds).toEqual(["missing-speaker"]);
    expect(errors).toContain("Could not switch audio output device.");
  });

  it("falls back to the default AudioContext destination when HTML audio playback is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    audioElement.rejectPlay = true;

    try {
      client.connect();
      transport.receive(
        JSON.stringify({ type: "audio_config", format: "mp3" })
      );
      transport.receive(new ArrayBuffer(4));

      const source = await waitForConnectedSource();

      expect(source.connectedTo).toBe(audioContext.destination);
      expect(audioElement.playCount).toBe(1);
      expect(audioElement.srcObject).toBeNull();
    } finally {
      warn.mockRestore();
    }
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
