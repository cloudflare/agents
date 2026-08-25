import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VoiceClient,
  type VoiceCompletionOutcome,
  type VoiceConnectionDiagnostic,
  type VoiceError,
  type VoiceTurnMetrics
} from "../voice-client";
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

  fail(cause?: unknown): void {
    this.onerror?.(cause);
  }
}

class FakeAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  stopped = false;
  started = false;
  startedAt: number | null = null;
  connectedTo: unknown = null;

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

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
  createdBuffers: Array<{ length: number; sampleRate: number }> = [];
  deferDecode = false;
  pendingDecode: (() => void) | null = null;
  destination = {};
  mediaStreamDestination = { stream: {} };
  mediaStreamDestinationCount = 0;

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
    this.createdBuffers.push({ length, sampleRate });
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

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    this.mediaStreamDestinationCount++;
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
  deferPlay = false;
  pendingPlayResolve: (() => void) | null = null;
  rejectSinkId = false;
  sinkIds: string[] = [];
  currentSinkId: string | null = null;
  deferredSinkIds = new Set<string>();
  pendingSinkIdResolves = new Map<string, () => void>();

  async play(): Promise<void> {
    this.playCount++;
    if (this.deferPlay) {
      await new Promise<void>((resolve) => {
        this.pendingPlayResolve = () => {
          this.deferPlay = false;
          this.pendingPlayResolve = null;
          resolve();
        };
      });
    }
    if (this.rejectPlay) throw new Error("play rejected");
  }

  pause(): void {
    this.paused = true;
  }

  async setSinkId(sinkId: string): Promise<void> {
    this.sinkIds.push(sinkId);
    if (this.deferredSinkIds.has(sinkId)) {
      await new Promise<void>((resolve) => {
        this.pendingSinkIdResolves.set(sinkId, () => {
          this.deferredSinkIds.delete(sinkId);
          this.pendingSinkIdResolves.delete(sinkId);
          resolve();
        });
      });
    }
    if (this.rejectSinkId) throw new Error("setSinkId rejected");
    this.currentSinkId = sinkId;
  }

  resolveSinkId(sinkId: string): void {
    this.pendingSinkIdResolves.get(sinkId)?.();
  }

  resolvePlay(): void {
    this.pendingPlayResolve?.();
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

class DeferredAudioInput implements VoiceAudioInput {
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData: ((pcm: ArrayBuffer) => void) | null = null;
  startCalled = false;
  running = false;
  stopCount = 0;
  #resolveStart: (() => void) | null = null;

  async start(): Promise<void> {
    this.startCalled = true;
    await new Promise<void>((resolve) => {
      this.#resolveStart = resolve;
    });
    this.running = true;
  }

  stop(): void {
    this.stopCount++;
    this.running = false;
  }

  resolveStart(): void {
    this.#resolveStart?.();
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

async function waitForPlayCount(count: number): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (audioElement.playCount >= count) return;
    await Promise.resolve();
  }
  throw new Error(`expected audio play count to reach ${count}`);
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

async function waitForAudioInputStart(
  audioInput: DeferredAudioInput
): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (audioInput.startCalled) return;
    await Promise.resolve();
  }
  throw new Error("expected audio input start to be called");
}

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

describe("VoiceClient diagnostics", () => {
  it("logs forwarded server and local client events with origin prefixes", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const transport = new MockTransport();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput: new FakeAudioInput()
    });
    const customMessages: unknown[] = [];
    client.addEventListener("custommessage", (message) =>
      customMessages.push(message)
    );

    try {
      client.connect();
      expect(info).not.toHaveBeenCalled();

      transport.receive(
        JSON.stringify({
          type: "welcome",
          protocol_version: 1,
          diagnostics: { browser_console: true }
        })
      );
      transport.receive(
        JSON.stringify({
          type: "diagnostic",
          event: "stt.ready",
          timestamp: 123,
          data: { duration_ms: 12 }
        })
      );
      await client.startCall();
      transport.receive(
        JSON.stringify({ type: "audio_config", format: "mp3" })
      );
      transport.receive(JSON.stringify({ type: "status", status: "speaking" }));
      transport.receive(
        JSON.stringify({
          type: "diagnostic",
          event: "audio.first_sent",
          timestamp: 456,
          data: { turn_id: "turn_audio", elapsed_ms: 99 }
        })
      );
      transport.receive(new ArrayBuffer(8));
      const source = await waitForConnectedSource();
      source.onended?.();

      expect(info).toHaveBeenCalledWith(
        "[voice:server] stt.ready",
        expect.objectContaining({ timestamp: 123, duration_ms: 12 })
      );
      expect(info).toHaveBeenCalledWith(
        "[voice:client] call.starting",
        expect.any(Object)
      );
      expect(info).toHaveBeenCalledWith(
        "[voice:client] microphone.ready",
        expect.objectContaining({ source: "custom" })
      );
      expect(info).toHaveBeenCalledWith(
        "[voice:client] audio.received",
        expect.objectContaining({ bytes: 8, turn_id: "turn_audio" })
      );
      const receivedEvent = info.mock.calls.find(
        ([label]) => label === "[voice:client] audio.received"
      )?.[1] as Record<string, unknown>;
      expect(receivedEvent).not.toHaveProperty("elapsed_ms");
      expect(info).toHaveBeenCalledWith(
        "[voice:client] playback.started",
        expect.objectContaining({ chunks: 1 })
      );
      expect(info).toHaveBeenCalledWith(
        "[voice:client] playback.completed",
        expect.any(Object)
      );
      expect(customMessages).toEqual([]);
    } finally {
      client.disconnect();
      info.mockRestore();
    }
  });

  it("consumes reserved diagnostics without logging when welcome opts out", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    const customMessages: unknown[] = [];
    client.addEventListener("custommessage", (message) =>
      customMessages.push(message)
    );

    try {
      client.connect();
      transport.receive(
        JSON.stringify({ type: "welcome", protocol_version: 1 })
      );
      transport.receive(
        JSON.stringify({
          type: "diagnostic",
          event: "call.ready",
          timestamp: 123
        })
      );

      expect(info).not.toHaveBeenCalled();
      expect(customMessages).toEqual([]);
    } finally {
      client.disconnect();
      info.mockRestore();
    }
  });

  it("isolates console logger failures from client behavior", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const transport = new MockTransport();
    const audioInput = new FakeAudioInput();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput
    });

    try {
      client.connect();
      expect(() =>
        transport.receive(
          JSON.stringify({
            type: "welcome",
            protocol_version: 1,
            diagnostics: { browser_console: true }
          })
        )
      ).not.toThrow();
      await expect(client.startCall()).resolves.toBeUndefined();
      expect(audioInput.started).toBe(true);
    } finally {
      client.disconnect();
      info.mockRestore();
    }
  });
});

describe("VoiceClient stable turn metrics", () => {
  it("updates the last-value getter and emits one typed terminal event", () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    const events: VoiceTurnMetrics[] = [];
    client.addEventListener("turnmetrics", (metrics) => events.push(metrics));
    client.connect();

    transport.receive(
      JSON.stringify({
        type: "turn_metrics",
        turnId: "turn_client",
        source: "text",
        outcome: "output_limit",
        turnTotalMs: 25,
        modelStreamConsumptionMs: 20
      })
    );

    expect(client.turnMetrics).toEqual({
      turnId: "turn_client",
      source: "text",
      outcome: "output_limit",
      turnTotalMs: 25,
      modelStreamConsumptionMs: 20
    });
    expect(events).toEqual([client.turnMetrics]);
    client.disconnect();
  });
});

describe("VoiceClient interim transcript lifecycle", () => {
  it("clears interim transcript when the call explicitly ends", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput: new FakeAudioInput()
    });
    const interimUpdates: Array<string | null> = [];
    client.addEventListener("interimtranscript", (text) =>
      interimUpdates.push(text)
    );

    client.connect();
    await client.startCall();
    interimUpdates.length = 0;
    transport.receive(
      JSON.stringify({ type: "transcript_interim", text: "unfinished phrase" })
    );
    expect(client.interimTranscript).toBe("unfinished phrase");

    client.endCall();

    expect(client.interimTranscript).toBeNull();
    expect(interimUpdates).toEqual(["unfinished phrase", null]);
  });

  it("clears stale interim transcript when a new call starts", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput: new FakeAudioInput()
    });
    const interimUpdates: Array<string | null> = [];
    client.addEventListener("interimtranscript", (text) =>
      interimUpdates.push(text)
    );

    client.connect();
    transport.receive(
      JSON.stringify({ type: "transcript_interim", text: "stale phrase" })
    );

    await client.startCall();

    expect(client.interimTranscript).toBeNull();
    expect(interimUpdates).toEqual(["stale phrase", null]);
  });

  it("clears interim transcript when the client disconnects", () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });

    client.connect();
    transport.receive(
      JSON.stringify({ type: "transcript_interim", text: "unfinished phrase" })
    );

    client.disconnect();

    expect(client.interimTranscript).toBeNull();
  });

  it("clears interim transcript when the transport closes", () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    const interimUpdates: Array<string | null> = [];
    client.addEventListener("interimtranscript", (text) =>
      interimUpdates.push(text)
    );

    client.connect();
    transport.receive(
      JSON.stringify({ type: "transcript_interim", text: "unfinished phrase" })
    );

    transport.disconnect();

    expect(client.interimTranscript).toBeNull();
    expect(interimUpdates).toEqual(["unfinished phrase", null]);
  });

  it("preserves live interim transcript on playback interruption", () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });

    client.connect();
    transport.receive(
      JSON.stringify({ type: "transcript_interim", text: "new live utterance" })
    );

    transport.receive(JSON.stringify({ type: "playback_interrupt" }));

    expect(client.interimTranscript).toBe("new live utterance");
  });

  it("clears interim transcript when startup fails", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput: new FakeAudioInput()
    });
    const interimUpdates: Array<string | null> = [];
    client.addEventListener("interimtranscript", (text) =>
      interimUpdates.push(text)
    );

    client.connect();
    await client.startCall();
    interimUpdates.length = 0;
    transport.receive(
      JSON.stringify({ type: "transcript_interim", text: "unfinished phrase" })
    );
    transport.receive(
      JSON.stringify({
        type: "error",
        message: "Speech recognition failed to start"
      })
    );

    transport.receive(JSON.stringify({ type: "status", status: "idle" }));

    expect(client.interimTranscript).toBeNull();
    expect(interimUpdates).toEqual(["unfinished phrase", null]);
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
    const outputDeviceErrors: Array<string | null> = [];
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "missing-speaker"
    });
    audioElement.rejectSinkId = true;
    client.addEventListener("outputdeviceerror", (error) =>
      outputDeviceErrors.push(error)
    );

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));

    const source = await waitForConnectedSource();

    expect(source.connectedTo).toBe(audioContext.mediaStreamDestination);
    expect(audioElement.playCount).toBe(1);
    expect(audioElement.sinkIds).toEqual(["missing-speaker"]);
    expect(outputDeviceErrors).toContain(
      "Could not switch audio output device."
    );
    expect(client.error).toBeNull();
    expect(client.outputDeviceError).toBe(
      "Could not switch audio output device."
    );
  });

  it("clears output device errors after a later successful switch", async () => {
    const transport = new MockTransport();
    const outputDeviceErrors: Array<string | null> = [];
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "missing-speaker"
    });
    audioElement.rejectSinkId = true;
    client.addEventListener("outputdeviceerror", (error) =>
      outputDeviceErrors.push(error)
    );

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await waitForConnectedSource();

    audioElement.rejectSinkId = false;
    await client.setOutputDevice("speaker-1");

    expect(outputDeviceErrors).toContain(
      "Could not switch audio output device."
    );
    expect(outputDeviceErrors.at(-1)).toBeNull();
    expect(client.outputDeviceError).toBeNull();
  });

  it("clears unsupported output device errors when switching back to default", async () => {
    const transport = new MockTransport();
    const outputDeviceErrors: Array<string | null> = [];
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "speaker-1"
    });
    (
      audioElement as { setSinkId?: (sinkId: string) => Promise<void> }
    ).setSinkId = undefined;
    client.addEventListener("outputdeviceerror", (error) =>
      outputDeviceErrors.push(error)
    );

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await waitForConnectedSource();

    await client.setOutputDevice();

    expect(outputDeviceErrors).toContain(
      "Audio output device selection is not supported in this browser."
    );
    expect(outputDeviceErrors.at(-1)).toBeNull();
    expect(client.outputDeviceError).toBeNull();
  });

  it("does not overwrite global errors when output device switching fails", async () => {
    const transport = new MockTransport();
    const globalErrors: Array<string | null> = [];
    const outputDeviceErrors: Array<string | null> = [];
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "missing-speaker"
    });
    audioElement.rejectSinkId = true;
    client.addEventListener("error", (error) => globalErrors.push(error));
    client.addEventListener("outputdeviceerror", (error) =>
      outputDeviceErrors.push(error)
    );

    client.connect();
    transport.receive(
      JSON.stringify({ type: "error", message: "Voice pipeline failed" })
    );
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));

    await waitForConnectedSource();

    expect(globalErrors).toContain("Voice pipeline failed");
    expect(globalErrors).not.toContain("Could not switch audio output device.");
    expect(client.error).toBe("Voice pipeline failed");
    expect(outputDeviceErrors).toContain(
      "Could not switch audio output device."
    );
  });

  it("keeps the latest output device when sink switches resolve out of order", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      outputDeviceId: "default"
    });

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await waitForConnectedSource();

    audioElement.deferredSinkIds.add("speaker-1");
    audioElement.deferredSinkIds.add("speaker-2");

    const firstSwitch = client.setOutputDevice("speaker-1");
    await Promise.resolve();
    const secondSwitch = client.setOutputDevice("speaker-2");
    await Promise.resolve();

    audioElement.resolveSinkId("speaker-2");
    await secondSwitch;
    expect(audioElement.currentSinkId).toBe("speaker-2");

    audioElement.resolveSinkId("speaker-1");
    await firstSwitch;

    expect(audioElement.currentSinkId).toBe("speaker-2");
    expect(audioElement.sinkIds).toEqual([
      "default",
      "speaker-1",
      "speaker-2",
      "speaker-2"
    ]);
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

  it("shares playback output setup when audio arrives while call start is prewarming playback", async () => {
    const transport = new MockTransport();
    const audioInput = new FakeAudioInput();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput
    });
    audioElement.deferPlay = true;

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));

    const startCall = client.startCall();
    await Promise.resolve();
    transport.receive(new ArrayBuffer(4));
    await waitForPlayCount(1);

    expect(audioContext.mediaStreamDestinationCount).toBe(1);
    expect(audioElement.playCount).toBe(1);

    audioElement.resolvePlay();
    await startCall;
    const source = await waitForConnectedSource();

    expect(source.connectedTo).toBe(audioContext.mediaStreamDestination);
    expect(audioContext.mediaStreamDestinationCount).toBe(1);
  });

  it("does not orphan playback output if call ends while HTML audio is starting", async () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    audioElement.deferPlay = true;

    client.connect();
    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(new ArrayBuffer(4));
    await waitForPlayCount(1);

    expect(audioElement.playCount).toBe(1);

    client.endCall();
    expect(audioElement.paused).toBe(true);
    expect(audioElement.srcObject).toBeNull();

    audioElement.resolvePlay();
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContext.source).toBeNull();
    expect(audioElement.paused).toBe(true);
    expect(audioElement.srcObject).toBeNull();
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

describe("VoiceClient errors", () => {
  it("emits typed LLM completion outcomes without changing the string error event", () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    const outcomes: VoiceCompletionOutcome[] = [];
    const errors: Array<string | null> = [];
    client.addEventListener("completionoutcome", (outcome) =>
      outcomes.push(outcome)
    );
    client.addEventListener("error", (error) => errors.push(error));

    client.connect();
    errors.length = 0;
    transport.receive(
      JSON.stringify({
        type: "completion_outcome",
        code: "output_limit",
        stage: "llm",
        finishReason: "length",
        partialOutput: true
      })
    );

    expect(outcomes).toEqual([
      {
        code: "output_limit",
        stage: "llm",
        finishReason: "length",
        partialOutput: true
      }
    ]);
    expect(errors).toEqual([]);
    expect(client.error).toBeNull();
  });

  it("emits structured server errors without changing the string error event", () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    const voiceErrors: VoiceError[] = [];
    const errors: Array<string | null> = [];
    client.addEventListener("voiceerror", (error) => voiceErrors.push(error));
    client.addEventListener("error", (error) => errors.push(error));

    client.connect();
    transport.receive(
      JSON.stringify({
        type: "error",
        message: "Speech recognition connection was lost",
        code: "stt_connection_lost",
        stage: "stt",
        retryable: true
      })
    );

    expect(voiceErrors).toEqual([
      {
        message: "Speech recognition connection was lost",
        code: "stt_connection_lost",
        stage: "stt",
        retryable: true
      }
    ]);
    expect(client.error).toBe("Speech recognition connection was lost");
    expect(errors.at(-1)).toBe("Speech recognition connection was lost");
  });

  it("emits a custom transport error cause as a connection diagnostic", () => {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    const cause = { code: "AUTH_FAILED", message: "expired token" };
    const diagnostics: VoiceConnectionDiagnostic[] = [];
    const errors: Array<string | null> = [];
    client.addEventListener("connectiondiagnostic", (diagnostic) =>
      diagnostics.push(diagnostic)
    );
    client.addEventListener("error", (error) => errors.push(error));

    client.connect();
    transport.fail(cause);

    expect(diagnostics).toEqual([{ type: "error", cause }]);
    const diagnostic = diagnostics[0];
    expect(diagnostic?.type).toBe("error");
    if (diagnostic?.type !== "error") throw new Error("expected error");
    expect(diagnostic.cause).toBe(cause);
    expect(client.error).toBe("Connection lost. Reconnecting...");
    expect(errors.at(-1)).toBe("Connection lost. Reconnecting...");
  });

  it("preserves a server error when an idle status follows it", () => {
    const transport = new MockTransport();
    const errors: Array<string | null> = [];
    const client = new VoiceClient({ agent: "test-agent", transport });
    client.addEventListener("error", (error) => errors.push(error));

    client.connect();
    transport.receive(
      JSON.stringify({
        type: "error",
        message: "Speech recognition failed to start"
      })
    );
    transport.receive(JSON.stringify({ type: "status", status: "idle" }));

    expect(client.error).toBe("Speech recognition failed to start");
    expect(errors.at(-1)).toBe("Speech recognition failed to start");

    transport.receive(JSON.stringify({ type: "status", status: "listening" }));

    expect(client.error).toBeNull();
    expect(errors.at(-1)).toBeNull();
  });

  it("stops local audio when a startup error returns the call to idle", async () => {
    const transport = new MockTransport();
    const audioInput = new FakeAudioInput();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput
    });

    client.connect();
    await client.startCall();

    expect(audioInput.started).toBe(true);
    expect(audioInput.stopped).toBe(false);
    expect(audioInput.onAudioLevel).not.toBeNull();
    expect(audioInput.onAudioData).not.toBeNull();

    transport.receive(
      JSON.stringify({
        type: "error",
        message: "Speech recognition failed to start"
      })
    );
    transport.receive(JSON.stringify({ type: "status", status: "idle" }));

    expect(client.status).toBe("idle");
    expect(client.error).toBe("Speech recognition failed to start");
    expect(audioInput.stopped).toBe(true);
    expect(audioInput.onAudioLevel).toBeNull();
    expect(audioInput.onAudioData).toBeNull();
    expect(transport.sentJSON).not.toContainEqual({ type: "end_call" });

    transport.disconnect();
    transport.connect();

    expect(
      transport.sentJSON.filter((message) => message.type === "start_call")
    ).toHaveLength(1);
  });

  it("stops local audio if startup fails before audio input start resolves", async () => {
    const transport = new MockTransport();
    const audioInput = new DeferredAudioInput();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput
    });

    client.connect();
    const startCall = client.startCall();
    await waitForAudioInputStart(audioInput);

    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(
      JSON.stringify({
        type: "error",
        message: "Speech recognition failed to start"
      })
    );
    transport.receive(JSON.stringify({ type: "status", status: "idle" }));

    expect(client.status).toBe("idle");
    expect(client.error).toBe("Speech recognition failed to start");
    expect(audioInput.stopCount).toBe(1);
    expect(audioInput.running).toBe(false);

    audioInput.resolveStart();
    await startCall;

    expect(audioInput.running).toBe(false);
    expect(audioInput.stopCount).toBe(2);
    expect(audioInput.onAudioLevel).toBeNull();
    expect(audioInput.onAudioData).toBeNull();
  });

  it("does not stop local audio for the initial idle status during startup", async () => {
    const transport = new MockTransport();
    const audioInput = new FakeAudioInput();
    const client = new VoiceClient({
      agent: "test-agent",
      transport,
      audioInput
    });

    client.connect();
    await client.startCall();

    transport.receive(JSON.stringify({ type: "status", status: "idle" }));

    expect(client.status).toBe("idle");
    expect(audioInput.started).toBe(true);
    expect(audioInput.stopped).toBe(false);
    expect(audioInput.onAudioLevel).not.toBeNull();
    expect(audioInput.onAudioData).not.toBeNull();

    transport.receive(JSON.stringify({ type: "audio_config", format: "mp3" }));
    transport.receive(JSON.stringify({ type: "status", status: "listening" }));

    expect(client.status).toBe("listening");
    expect(audioInput.stopped).toBe(false);
  });
});

describe("VoiceClient gapless playback", () => {
  // 1600 samples of 16-bit PCM = 0.1s at 16kHz
  function pcm16Chunk(): ArrayBuffer {
    return new ArrayBuffer(1600 * 2);
  }

  function startPcm16Call(sampleRate?: number): {
    transport: MockTransport;
    client: VoiceClient;
  } {
    const transport = new MockTransport();
    const client = new VoiceClient({ agent: "test-agent", transport });
    client.connect();
    transport.receive(
      JSON.stringify({
        type: "audio_config",
        format: "pcm16",
        ...(sampleRate !== undefined ? { sampleRate } : {})
      })
    );
    return { transport, client };
  }

  it("uses the sampleRate from audio_config when playing pcm16", async () => {
    const { transport, client } = startPcm16Call(24000);
    expect(client.sampleRate).toBe(24000);

    // 2400 samples at 24kHz = 0.1s
    transport.receive(new ArrayBuffer(2400 * 2));
    await waitForSourceCount(1);

    expect(audioContext.createdBuffers).toEqual([
      { length: 2400, sampleRate: 24000 }
    ]);
    expect(audioContext.sources[0]?.startedAt).toBe(0);
  });

  it("defaults pcm16 sampleRate to 16000 when audio_config omits it", async () => {
    const { transport, client } = startPcm16Call();
    expect(client.sampleRate).toBe(16000);

    transport.receive(pcm16Chunk());
    await waitForSourceCount(1);

    expect(audioContext.createdBuffers).toEqual([
      { length: 1600, sampleRate: 16000 }
    ]);
  });

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

describe("VoiceClient playback bridge reuse", () => {
  // The audible symptom (a new turn plays back slow, then re-converges) lives
  // inside the HTMLAudioElement's playout and is not observable from JS, so we
  // cannot assert playback speed. Instead we lock in the mechanism the fix
  // relies on: a bridge that has gone idle between turns is rebuilt, not reused,
  // and is never rebuilt mid-turn.
  function pcm16Chunk(): ArrayBuffer {
    // 1600 samples of 16-bit PCM = 0.1s at 16kHz
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

  it("reuses the playback bridge for consecutive chunks within a turn", async () => {
    const { transport } = startPcm16Call();
    audioContext.currentTime = 5;

    transport.receive(pcm16Chunk());
    transport.receive(pcm16Chunk());
    await waitForSourceCount(2);

    // Chunks within a turn stay scheduled ahead on the cursor, so the bridge
    // must not be torn down between them.
    expect(audioContext.mediaStreamDestinationCount).toBe(1);
    expect(audioElement.playCount).toBe(1);
  });

  it("rebuilds the playback bridge for a new turn after it has gone idle", async () => {
    const { transport } = startPcm16Call();

    // Turn 1: one chunk ending at t=5.1.
    audioContext.currentTime = 5;
    transport.receive(pcm16Chunk());
    const [first] = await waitForSourceCount(1);
    expect(audioContext.mediaStreamDestinationCount).toBe(1);

    // Turn 1 finishes playing and the bridge drains.
    first.stop();

    // A gap longer than the idle threshold passes before the next turn.
    audioContext.currentTime = 5.5; // 0.4s past the last chunk's end (5.1)
    transport.receive(pcm16Chunk());
    await waitForSourceCount(2);

    // The idle bridge is torn down and a fresh one is built for turn 2.
    expect(audioContext.mediaStreamDestinationCount).toBe(2);
    expect(audioElement.playCount).toBe(2);
  });

  it("rebuilds the playback bridge for a new turn after an interrupt and idle gap", async () => {
    const { transport } = startPcm16Call();

    // Turn 1 starts playing, then is interrupted mid-playback (abrupt stop,
    // not a natural drain).
    audioContext.currentTime = 5;
    transport.receive(pcm16Chunk());
    await waitForSourceCount(1);
    expect(audioContext.mediaStreamDestinationCount).toBe(1);
    transport.receive(JSON.stringify({ type: "playback_interrupt" }));

    // A gap longer than the idle threshold passes before the next turn.
    audioContext.currentTime = 6; // 1s after the interrupt
    transport.receive(pcm16Chunk());
    await waitForSourceCount(2);

    // The bridge went idle at the interrupt, so the next turn must rebuild it.
    expect(audioContext.mediaStreamDestinationCount).toBe(2);
    expect(audioElement.playCount).toBe(2);
  });

  it("reuses the playback bridge when the next turn follows within the idle threshold", async () => {
    const { transport } = startPcm16Call();

    audioContext.currentTime = 5;
    transport.receive(pcm16Chunk());
    const [first] = await waitForSourceCount(1);
    first.stop();

    // Next chunk arrives only 0.1s after the previous chunk's end (< 0.3s).
    audioContext.currentTime = 5.2;
    transport.receive(pcm16Chunk());
    await waitForSourceCount(2);

    expect(audioContext.mediaStreamDestinationCount).toBe(1);
    expect(audioElement.playCount).toBe(1);
  });
});
