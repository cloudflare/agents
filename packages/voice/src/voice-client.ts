import { PartySocket } from "partysocket";
import { VOICE_PROTOCOL_VERSION } from "./types";

function camelCaseToKebabCase(str: string): string {
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }
  let kebabified = str.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}
import type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceTransport,
  TranscriptMessage,
  VoicePipelineMetrics
} from "./types";

// Re-export shared types for consumers importing from this module
export { VOICE_PROTOCOL_VERSION } from "./types";
export type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceTransport,
  VoicePipelineMetrics,
  TranscriptMessage
} from "./types";

export interface VoiceClientOptions {
  /** Agent name (matches the server-side Durable Object class). */
  agent: string;
  /** Instance name for the agent. @default "default" */
  name?: string;

  // Connection options (optional — defaults work for same-origin)
  /** Host to connect to. @default window.location.host */
  host?: string;

  /** Query parameters appended to the WebSocket URL. */
  query?: Record<string, string | null | undefined>;

  /**
   * Custom transport for sending/receiving data.
   * Defaults to a WebSocket transport via PartySocket.
   * Provide a custom implementation for WebRTC, SFU, or other transports.
   */
  transport?: VoiceTransport;

  /**
   * Custom audio input source. When provided, VoiceClient does NOT
   * use its built-in AudioWorklet mic capture. The audio input is
   * responsible for capturing and routing audio to the server.
   * It must report audio levels via `onAudioLevel` for silence and
   * interrupt detection to work.
   */
  audioInput?: VoiceAudioInput;

  /**
   * Preferred audio format for server responses. Sent in `start_call`
   * as a hint — the server may ignore it if it cannot produce that format.
   * The actual format is declared in the server's `audio_config` message.
   */
  preferredFormat?: VoiceAudioFormat;

  // Tuning knobs with sensible defaults
  /** RMS threshold below which audio is considered silence. @default 0.04 */
  silenceThreshold?: number;
  /** How long silence must last before sending end_of_speech (ms). @default 500 */
  silenceDurationMs?: number;
  /** RMS threshold for detecting user speech during agent playback. @default 0.05 */
  interruptThreshold?: number;
  /** Consecutive high-RMS chunks needed to trigger an interrupt. @default 2 */
  interruptChunks?: number;
  /** Maximum transcript messages to keep in memory. @default 200 */
  maxTranscriptMessages?: number;

  /**
   * Preferred audio output device for assistant playback.
   * Pass a MediaDeviceInfo.deviceId from an audiooutput device.
   * Unsupported browsers continue playing through the default output.
   * @default "default"
   */
  outputDeviceId?: string;
}

type AudioElementWithSinkId = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

const UNSUPPORTED_OUTPUT_DEVICE_ERROR =
  "Audio output device selection is not supported in this browser.";
const OUTPUT_DEVICE_SWITCH_ERROR = "Could not switch audio output device.";

/** Maps each event name to the data type passed to its listeners. */
export interface VoiceClientEventMap {
  statuschange: VoiceStatus;
  transcriptchange: TranscriptMessage[];
  interimtranscript: string | null;
  metricschange: VoicePipelineMetrics | null;
  audiolevelchange: number;
  connectionchange: boolean;
  error: string | null;
  outputdeviceerror: string | null;
  mutechange: boolean;
  custommessage: unknown;
}

export type VoiceClientEvent = keyof VoiceClientEventMap;

// --- Audio helpers (not exported) ---

const WORKLET_PROCESSOR = `
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.sampleRate = sampleRate;
    this.targetRate = 16000;
    this.ratio = this.sampleRate / this.targetRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    // Linear interpolation resampling (e.g. 48kHz → 16kHz).
    // Nearest-neighbor (picking every Nth sample) introduces aliasing
    // artifacts, especially on sibilants (s, f, th). Linear interpolation
    // blends adjacent samples, acting as a basic low-pass filter.
    for (let i = 0; i < channelData.length; i += this.ratio) {
      const idx = Math.floor(i);
      const frac = i - idx;
      if (idx + 1 < channelData.length) {
        this.buffer.push(channelData[idx] * (1 - frac) + channelData[idx + 1] * frac);
      } else if (idx < channelData.length) {
        this.buffer.push(channelData[idx]);
      }
    }

    if (this.buffer.length >= 1600) {
      const chunk = new Float32Array(this.buffer);
      this.port.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
      this.buffer = [];
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
`;

function floatTo16BitPCM(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// --- Default WebSocket transport ---

/**
 * Default VoiceTransport backed by PartySocket (reconnecting WebSocket).
 * Created automatically when no custom transport is provided.
 */
export class WebSocketVoiceTransport implements VoiceTransport {
  #socket: PartySocket | null = null;
  #options: {
    agent: string;
    name?: string;
    host?: string;
    query?: Record<string, string | null | undefined>;
  };

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  constructor(options: {
    agent: string;
    name?: string;
    host?: string;
    query?: Record<string, string | null | undefined>;
  }) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  sendJSON(data: Record<string, unknown>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(data));
    }
  }

  sendBinary(data: ArrayBuffer): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(data);
    }
  }

  connect(): void {
    if (this.#socket) return;

    const agentNamespace = camelCaseToKebabCase(this.#options.agent);

    const socket = new PartySocket({
      party: agentNamespace,
      room: this.#options.name ?? "default",
      host: this.#options.host ?? window.location.host,
      prefix: "agents",
      query: this.#options.query
    });

    socket.onopen = () => this.onopen?.();
    socket.onclose = () => this.onclose?.();
    socket.onerror = () => this.onerror?.();
    socket.onmessage = (event: MessageEvent) => {
      this.onmessage?.(event.data);
    };

    this.#socket = socket;
  }

  disconnect(): void {
    this.#socket?.close();
    this.#socket = null;
  }
}

// --- VoiceClient ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic listener storage
type AnyListener = (data: any) => void;

export class VoiceClient {
  // Internal state
  #status: VoiceStatus = "idle";
  #transcript: TranscriptMessage[] = [];
  #metrics: VoicePipelineMetrics | null = null;
  #audioLevel = 0;
  #isMuted = false;
  #connected = false;
  #error: string | null = null;
  #outputDeviceError: string | null = null;
  #lastCustomMessage: unknown = null;
  #audioFormat: VoiceAudioFormat | null = null;
  #interimTranscript: string | null = null;
  #serverProtocolVersion: number | null = null;
  #inCall = false;

  // Options (with defaults applied)
  #silenceThreshold: number;
  #silenceDurationMs: number;
  #interruptThreshold: number;
  #interruptChunks: number;
  #maxTranscriptMessages: number;

  // Transport
  #transport: VoiceTransport | null = null;
  #options: VoiceClientOptions;

  // Audio refs
  #audioContext: AudioContext | null = null;
  #workletRegistered = false;
  #workletNode: AudioWorkletNode | null = null;
  #stream: MediaStream | null = null;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #isSpeaking = false;
  #playbackQueue: ArrayBuffer[] = [];
  #isPlaying = false;
  #isScheduling = false;
  #scheduledSources = new Set<AudioBufferSourceNode>();
  #playbackCursor = 0;
  // End time (on the AudioContext clock) of the most recently scheduled chunk.
  // Used to detect when the playback bridge has been idle across the gap
  // between turns so it can be rebuilt (see #playAudio).
  #lastPlaybackEnd: number | null = null;
  #playbackElement: HTMLAudioElement | null = null;
  #playbackDestination: MediaStreamAudioDestinationNode | null = null;
  #playbackDestinationPromise: Promise<AudioNode> | null = null;
  #useDefaultPlaybackDestination = false;
  #outputDeviceId: string;
  #outputDeviceSwitchGeneration = 0;
  #playbackOutputGeneration = 0;
  #playbackGeneration = 0;
  #interruptChunkCount = 0;

  // Event listeners
  #listeners = new Map<VoiceClientEvent, Set<AnyListener>>();

  constructor(options: VoiceClientOptions) {
    this.#options = options;
    this.#silenceThreshold = options.silenceThreshold ?? 0.04;
    this.#silenceDurationMs = options.silenceDurationMs ?? 500;
    this.#interruptThreshold = options.interruptThreshold ?? 0.05;
    this.#interruptChunks = options.interruptChunks ?? 2;
    this.#maxTranscriptMessages = options.maxTranscriptMessages ?? 200;
    this.#outputDeviceId = options.outputDeviceId ?? "default";
  }

  // --- Public getters ---

  get status(): VoiceStatus {
    return this.#status;
  }

  get transcript(): TranscriptMessage[] {
    return this.#transcript;
  }

  get metrics(): VoicePipelineMetrics | null {
    return this.#metrics;
  }

  get audioLevel(): number {
    return this.#audioLevel;
  }

  get isMuted(): boolean {
    return this.#isMuted;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get error(): string | null {
    return this.#error;
  }

  get outputDeviceError(): string | null {
    return this.#outputDeviceError;
  }

  /**
   * The current interim (partial) transcript from streaming STT.
   * Updates in real time as the user speaks. Cleared when the final
   * transcript is produced. null when no interim text is available.
   */
  get interimTranscript(): string | null {
    return this.#interimTranscript;
  }

  /**
   * The protocol version reported by the server.
   * null until the server sends its welcome message.
   */
  get serverProtocolVersion(): number | null {
    return this.#serverProtocolVersion;
  }

  // --- Event system ---

  addEventListener<K extends VoiceClientEvent>(
    event: K,
    listener: (data: VoiceClientEventMap[K]) => void
  ): void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as AnyListener);
  }

  removeEventListener<K extends VoiceClientEvent>(
    event: K,
    listener: (data: VoiceClientEventMap[K]) => void
  ): void {
    this.#listeners.get(event)?.delete(listener as AnyListener);
  }

  #emit<K extends VoiceClientEvent>(
    event: K,
    data: VoiceClientEventMap[K]
  ): void {
    const set = this.#listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }

  #trimTranscript(): void {
    if (this.#transcript.length > this.#maxTranscriptMessages) {
      this.#transcript = this.#transcript.slice(-this.#maxTranscriptMessages);
    }
  }

  #setOutputDeviceError(error: string | null): void {
    if (this.#outputDeviceError === error) return;
    this.#outputDeviceError = error;
    this.#emit("outputdeviceerror", error);
  }

  // --- Connection ---

  connect(): void {
    if (this.#transport) return;

    const transport =
      this.#options.transport ??
      new WebSocketVoiceTransport({
        agent: this.#options.agent,
        name: this.#options.name,
        host: this.#options.host,
        query: this.#options.query
      });

    transport.onopen = () => {
      this.#connected = true;
      this.#error = null;
      // Announce our protocol version to the server
      transport.sendJSON({
        type: "hello",
        protocol_version: VOICE_PROTOCOL_VERSION
      });
      this.#emit("connectionchange", true);
      this.#emit("error", null);

      // Reconnect recovery: if we were in a call when the connection
      // dropped, re-establish it on the new connection. The mic is
      // still running (not stopped on disconnect), so audio resumes
      // flowing as soon as the server processes start_call.
      if (this.#inCall) {
        transport.sendJSON({ type: "start_call" });
      }
    };

    transport.onclose = () => {
      this.#connected = false;
      this.#emit("connectionchange", false);
    };

    transport.onerror = () => {
      this.#error = "Connection lost. Reconnecting...";
      this.#emit("error", this.#error);
    };

    transport.onmessage = (data: string | ArrayBuffer | Blob) => {
      if (typeof data === "string") {
        this.#handleJSONMessage(data);
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buffer) => {
          this.#playbackQueue.push(buffer);
          this.#processPlaybackQueue();
        });
      } else if (data instanceof ArrayBuffer) {
        this.#playbackQueue.push(data);
        this.#processPlaybackQueue();
      }
    };

    this.#transport = transport;
    transport.connect();
  }

  disconnect(): void {
    this.endCall();
    this.#transport?.disconnect();
    this.#transport = null;
    this.#connected = false;
    this.#emit("connectionchange", false);
  }

  // --- Public actions ---

  async startCall(): Promise<void> {
    if (!this.#transport?.connected) {
      this.#error = "Cannot start call: not connected. Call connect() first.";
      this.#emit("error", this.#error);
      return;
    }
    this.#inCall = true;
    this.#error = null;
    this.#metrics = null;
    this.#emit("error", null);
    this.#emit("metricschange", null);
    const startMsg: Record<string, unknown> = { type: "start_call" };
    if (this.#options.preferredFormat) {
      startMsg.preferred_format = this.#options.preferredFormat;
    }
    this.#transport.sendJSON(startMsg);
    const ctx = await this.#getAudioContext();
    await this.#getPlaybackDestination(ctx);
    if (this.#options.audioInput) {
      this.#options.audioInput.onAudioLevel = (rms) =>
        this.#processAudioLevel(rms);
      this.#options.audioInput.onAudioData = (pcm) => {
        if (this.#transport?.connected && !this.#isMuted) {
          this.#transport.sendBinary(pcm);
        }
      };
      await this.#options.audioInput.start();
    } else {
      await this.#startMic();
    }
  }

  endCall(): void {
    this.#inCall = false;
    if (this.#transport?.connected) {
      this.#transport.sendJSON({ type: "end_call" });
    }
    if (this.#options.audioInput) {
      this.#options.audioInput.stop();
      this.#options.audioInput.onAudioLevel = null;
      this.#options.audioInput.onAudioData = null;
    } else {
      this.#stopMic();
    }
    this.#stopPlayback();
    this.#closeAudioContext();
    this.#resetDetection();
    this.#status = "idle";
    this.#emit("statuschange", "idle");
  }

  toggleMute(): void {
    this.#isMuted = !this.#isMuted;

    // Reset audio level so the UI shows silence while muted.
    if (this.#isMuted) {
      this.#audioLevel = 0;
      this.#emit("audiolevelchange", 0);
    }

    // If muting while speaking, flush the current utterance so the server
    // processes accumulated audio instead of waiting forever (deadlock:
    // muted → no audio frames → silence timer never starts → no end_of_speech).
    if (this.#isMuted && this.#isSpeaking) {
      this.#isSpeaking = false;
      if (this.#silenceTimer) {
        clearTimeout(this.#silenceTimer);
        this.#silenceTimer = null;
      }
      if (this.#transport?.connected) {
        this.#transport.sendJSON({ type: "end_of_speech" });
      }
    }

    this.#emit("mutechange", this.#isMuted);
  }

  /**
   * Send a text message to the agent. The agent processes it through
   * `onTurn()` (bypassing STT) and responds with text transcript and
   * TTS audio (if in a call) or text-only (if not).
   */
  sendText(text: string): void {
    if (this.#transport?.connected) {
      this.#transport.sendJSON({ type: "text_message", text });
    }
  }

  /**
   * Send arbitrary JSON to the agent. Use this for app-level messages
   * that are not part of the voice protocol (e.g. `{ type: "kick_speaker" }`).
   * The server receives these in the consumer's `onMessage()` handler.
   */
  sendJSON(data: Record<string, unknown>): void {
    if (this.#transport?.connected) {
      this.#transport.sendJSON(data);
    }
  }

  /**
   * Set the preferred audio output device for assistant playback.
   * Unsupported browsers continue playing through the default output.
   */
  async setOutputDevice(outputDeviceId?: string): Promise<void> {
    this.#outputDeviceId = outputDeviceId ?? "default";
    const generation = ++this.#outputDeviceSwitchGeneration;
    if (this.#playbackElement) {
      await this.#applyOutputDevice(this.#playbackElement, generation);
    }
  }

  /**
   * The last custom (non-voice-protocol) message received from the server.
   * Listen for the `"custommessage"` event to be notified when this changes.
   */
  get lastCustomMessage(): unknown {
    return this.#lastCustomMessage;
  }

  /**
   * The audio format the server declared for binary payloads.
   * Set when the server sends `audio_config` at call start.
   */
  get audioFormat(): VoiceAudioFormat | null {
    return this.#audioFormat;
  }

  // --- Voice protocol handler ---

  #handleJSONMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      // Not JSON — ignore (e.g. state sync binary frames)
      return;
    }

    switch (msg.type) {
      case "welcome":
        this.#serverProtocolVersion = msg.protocol_version as number;
        if (msg.protocol_version !== VOICE_PROTOCOL_VERSION) {
          console.warn(
            `[VoiceClient] Protocol version mismatch: client=${VOICE_PROTOCOL_VERSION}, server=${msg.protocol_version}`
          );
        }
        break;
      case "audio_config":
        this.#audioFormat = msg.format as VoiceAudioFormat;
        break;
      case "status":
        this.#status = msg.status as VoiceStatus;
        if (msg.status === "listening" || msg.status === "idle") {
          this.#error = null;
          this.#emit("error", null);
        }
        this.#emit("statuschange", this.#status);
        break;
      case "transcript_interim":
        this.#interimTranscript = msg.text as string;
        this.#emit("interimtranscript", this.#interimTranscript);
        break;
      case "playback_interrupt":
        this.#stopPlayback();
        break;
      case "transcript":
        // Final transcript arrived — clear interim
        this.#interimTranscript = null;
        this.#emit("interimtranscript", null);

        // New user utterance while agent is playing -- stop playback.
        // With continuous STT, the model detects the user's speech
        // server-side, so this arrives before the client's interrupt
        // detection fires.
        if (msg.role === "user" && this.#isPlaying) this.#stopPlayback();

        this.#transcript = [
          ...this.#transcript,
          {
            role: msg.role as VoiceRole,
            text: msg.text as string,
            timestamp: Date.now()
          }
        ];
        this.#trimTranscript();
        this.#emit("transcriptchange", this.#transcript);
        break;
      case "transcript_start":
        this.#transcript = [
          ...this.#transcript,
          { role: "assistant", text: "", timestamp: Date.now() }
        ];
        this.#trimTranscript();
        this.#emit("transcriptchange", this.#transcript);
        break;
      case "transcript_delta": {
        if (this.#transcript.length === 0) break;
        const updated = [...this.#transcript];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            text: last.text + (msg.text as string)
          };
          this.#transcript = updated;
          this.#emit("transcriptchange", this.#transcript);
        }
        break;
      }
      case "transcript_end": {
        if (this.#transcript.length === 0) break;
        const updated = [...this.#transcript];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            text: msg.text as string
          };
          this.#transcript = updated;
          this.#emit("transcriptchange", this.#transcript);
        }
        break;
      }
      case "metrics":
        this.#metrics = {
          llm_ms: msg.llm_ms as number,
          tts_ms: msg.tts_ms as number,
          first_audio_ms: msg.first_audio_ms as number,
          total_ms: msg.total_ms as number
        };
        this.#emit("metricschange", this.#metrics);
        break;
      case "error":
        this.#error = msg.message as string;
        this.#emit("error", this.#error);
        break;
      default:
        // App-level custom message — surface via event
        this.#lastCustomMessage = msg;
        this.#emit("custommessage", msg);
        break;
    }
  }

  // --- Audio context management ---

  /** Get or create the shared AudioContext. */
  async #getAudioContext(): Promise<AudioContext> {
    if (!this.#audioContext) {
      this.#audioContext = new AudioContext({ sampleRate: 48000 });
    }
    if (this.#audioContext.state === "suspended") {
      await this.#audioContext.resume();
    }
    return this.#audioContext;
  }

  /** Close the AudioContext and release resources. */
  #closeAudioContext(): void {
    if (this.#audioContext) {
      this.#closePlaybackOutput();
      this.#audioContext.close().catch(() => {});
      this.#audioContext = null;
      this.#workletRegistered = false;
    }
  }

  async #getPlaybackDestination(ctx: AudioContext): Promise<AudioNode> {
    if (this.#playbackDestinationPromise) {
      return this.#playbackDestinationPromise;
    }
    if (this.#playbackDestination) return this.#playbackDestination;
    if (this.#useDefaultPlaybackDestination) return ctx.destination;

    const outputGeneration = this.#playbackOutputGeneration;
    const promise = this.#initializePlaybackDestination(ctx, outputGeneration);
    this.#playbackDestinationPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#playbackDestinationPromise === promise) {
        this.#playbackDestinationPromise = null;
      }
    }
  }

  async #initializePlaybackDestination(
    ctx: AudioContext,
    outputGeneration: number
  ): Promise<AudioNode> {
    try {
      const destination = ctx.createMediaStreamDestination();
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = destination.stream;
      this.#playbackElement = audio;
      this.#playbackDestination = destination;
      await this.#applyOutputDevice(audio, this.#outputDeviceSwitchGeneration);
      if (!this.#isCurrentPlaybackOutput(audio, outputGeneration)) {
        this.#releasePlaybackElement(audio);
        return ctx.destination;
      }
      await audio.play();
      if (!this.#isCurrentPlaybackOutput(audio, outputGeneration)) {
        this.#releasePlaybackElement(audio);
        return ctx.destination;
      }
      return destination;
    } catch (err) {
      console.warn(
        "[VoiceClient] HTMLAudioElement playback output unavailable; using default AudioContext destination.",
        err
      );
      this.#closePlaybackOutput();
      this.#useDefaultPlaybackDestination = true;
      return ctx.destination;
    }
  }

  #isCurrentPlaybackOutput(
    audio: HTMLAudioElement,
    outputGeneration: number
  ): boolean {
    return (
      this.#playbackElement === audio &&
      this.#playbackOutputGeneration === outputGeneration
    );
  }

  async #applyOutputDevice(
    audio: HTMLAudioElement,
    generation: number
  ): Promise<void> {
    const sinkId = this.#outputDeviceId;
    const setSinkId = (audio as AudioElementWithSinkId).setSinkId;
    if (!setSinkId) {
      if (sinkId === "default") {
        this.#setOutputDeviceError(null);
        return;
      }
      this.#setOutputDeviceError(UNSUPPORTED_OUTPUT_DEVICE_ERROR);
      return;
    }

    try {
      await setSinkId.call(audio, sinkId);
      if (
        generation !== this.#outputDeviceSwitchGeneration ||
        sinkId !== this.#outputDeviceId
      ) {
        if (this.#playbackElement === audio) {
          await this.#applyOutputDevice(
            audio,
            this.#outputDeviceSwitchGeneration
          );
        }
        return;
      }
      if (
        this.#outputDeviceError === UNSUPPORTED_OUTPUT_DEVICE_ERROR ||
        this.#outputDeviceError === OUTPUT_DEVICE_SWITCH_ERROR
      ) {
        this.#setOutputDeviceError(null);
      }
    } catch {
      if (
        generation !== this.#outputDeviceSwitchGeneration ||
        sinkId !== this.#outputDeviceId
      ) {
        if (this.#playbackElement === audio) {
          await this.#applyOutputDevice(
            audio,
            this.#outputDeviceSwitchGeneration
          );
        }
        return;
      }
      this.#setOutputDeviceError(OUTPUT_DEVICE_SWITCH_ERROR);
    }
  }

  #closePlaybackOutput(): void {
    this.#playbackOutputGeneration++;
    if (this.#playbackElement) {
      this.#releasePlaybackElement(this.#playbackElement);
      this.#playbackElement = null;
    }
    this.#playbackDestination = null;
    this.#playbackDestinationPromise = null;
    this.#useDefaultPlaybackDestination = false;
  }

  #releasePlaybackElement(audio: HTMLAudioElement): void {
    audio.pause();
    audio.srcObject = null;
  }

  // --- Audio playback ---

  async #playAudio(audioData: ArrayBuffer, generation: number): Promise<void> {
    try {
      const ctx = await this.#getAudioContext();

      let audioBuffer: AudioBuffer;
      if (this.#audioFormat === "pcm16") {
        // Raw 16-bit LE mono PCM at 16kHz — manually construct AudioBuffer
        const int16 = new Int16Array(audioData);
        audioBuffer = ctx.createBuffer(1, int16.length, 16000);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < int16.length; i++) {
          channel[i] = int16[i] / 32768;
        }
      } else {
        // mp3, wav, opus — let the browser decode
        audioBuffer = await ctx.decodeAudioData(audioData.slice(0));
      }
      if (generation !== this.#playbackGeneration) return;

      // Assistant playback is routed through a MediaStreamAudioDestinationNode
      // -> HTMLAudioElement bridge (so a selected output device can be honored
      // via HTMLMediaElement.setSinkId). That bridge is a live playout path:
      // when it is reused for a new turn after sitting idle through the gap
      // between turns, the element resumes the fresh burst at the wrong rate and
      // the new turn plays back noticeably slow (it then re-converges to normal
      // over the turn). A freshly created element does not show this, so once
      // the bridge has fully drained and been idle past a short threshold, tear
      // it down; #getPlaybackDestination rebuilds a fresh element for this turn.
      // The scheduledSources.size === 0 guard means this never fires mid-turn:
      // chunks within a turn are scheduled ahead on the cursor, keeping at least
      // one source live until the turn finishes.
      const BRIDGE_IDLE_REBUILD_SECONDS = 0.3;
      if (
        this.#playbackElement &&
        this.#scheduledSources.size === 0 &&
        this.#lastPlaybackEnd !== null &&
        ctx.currentTime - this.#lastPlaybackEnd > BRIDGE_IDLE_REBUILD_SECONDS
      ) {
        this.#closePlaybackOutput();
      }

      const destination = await this.#getPlaybackDestination(ctx);
      if (generation !== this.#playbackGeneration) return;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(destination);
      this.#scheduledSources.add(source);
      source.onended = () => {
        this.#scheduledSources.delete(source);
        if (
          generation === this.#playbackGeneration &&
          !this.#isScheduling &&
          this.#scheduledSources.size === 0 &&
          this.#playbackQueue.length === 0
        ) {
          this.#isPlaying = false;
        }
      };

      // Schedule on the audio clock, butted against the previous chunk.
      // Starting at currentTime only after the previous chunk's `ended`
      // event leaves a few ms of silence at every chunk seam, audible as
      // a periodic click during agent speech.
      const startAt = Math.max(ctx.currentTime, this.#playbackCursor);
      this.#playbackCursor = startAt + audioBuffer.duration;
      this.#lastPlaybackEnd = this.#playbackCursor;
      source.start(startAt);
    } catch (err) {
      console.error("[VoiceClient] Audio playback error:", err);
    }
  }

  async #processPlaybackQueue(): Promise<void> {
    if (this.#isScheduling || this.#playbackQueue.length === 0) return;
    this.#isScheduling = true;
    this.#isPlaying = true;
    const generation = this.#playbackGeneration;

    while (
      generation === this.#playbackGeneration &&
      this.#playbackQueue.length > 0
    ) {
      const audioData = this.#playbackQueue.shift()!;
      await this.#playAudio(audioData, generation);
    }

    if (generation === this.#playbackGeneration) {
      this.#isScheduling = false;
      if (this.#scheduledSources.size === 0) {
        this.#isPlaying = false;
      }
    }
  }

  #stopPlayback(): void {
    this.#playbackGeneration++;
    const sources = [...this.#scheduledSources];
    this.#scheduledSources.clear();
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // The source may already have ended or been stopped by another signal.
      }
    }
    this.#playbackQueue = [];
    this.#isPlaying = false;
    this.#isScheduling = false;
    this.#playbackCursor = 0;
    // An interrupt (barge-in or a user transcript) stops playback abruptly, so
    // the bridge goes idle from now, not from the cut chunk's scheduled end.
    // Record the current audio-clock time as the idle start so the next turn's
    // rebuild check in #playAudio still fires after interrupt -> long pause ->
    // new turn. Nulling this here would disable that check and let the slow-
    // playback symptom reappear on the post-interrupt turn.
    this.#lastPlaybackEnd = this.#audioContext
      ? this.#audioContext.currentTime
      : null;
  }

  // --- Mic capture ---

  async #startMic(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 48000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      this.#stream = stream;

      const ctx = await this.#getAudioContext();

      // Only register the worklet processor once per AudioContext.
      // Calling addModule twice with the same processor name throws.
      if (!this.#workletRegistered) {
        const blob = new Blob([WORKLET_PROCESSOR], {
          type: "application/javascript"
        });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);
        this.#workletRegistered = true;
      }

      const source = ctx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(ctx, "audio-capture-processor");
      this.#workletNode = workletNode;

      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "audio" && !this.#isMuted) {
          const samples = event.data.samples as Float32Array;
          const rms = computeRMS(samples);

          // Send PCM to agent
          const pcm = floatTo16BitPCM(samples);
          if (this.#transport?.connected) {
            this.#transport.sendBinary(pcm);
          }

          this.#processAudioLevel(rms);
        }
      };

      source.connect(workletNode);
      workletNode.connect(ctx.destination);
    } catch (err) {
      console.error("[VoiceClient] Mic error:", err);
      this.#error =
        "Microphone access denied. Please allow microphone access and try again.";
      this.#emit("error", this.#error);
    }
  }

  #stopMic(): void {
    this.#workletNode?.disconnect();
    this.#workletNode = null;
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.#resetDetection();
  }

  // --- Audio level processing (shared between built-in mic and custom audioInput) ---

  #processAudioLevel(rms: number): void {
    // When muted, ignore incoming audio levels. This prevents false
    // speech detection when a custom audioInput keeps reporting levels.
    // The built-in mic already gates on !#isMuted before calling here,
    // but audioInput implementations don't know about mute state.
    if (this.#isMuted) return;

    this.#audioLevel = rms;
    this.#emit("audiolevelchange", rms);

    // Interruption detection: user speaking during agent playback
    if (this.#isPlaying && rms > this.#interruptThreshold) {
      this.#interruptChunkCount++;
      if (this.#interruptChunkCount >= this.#interruptChunks) {
        this.#stopPlayback();
        this.#interruptChunkCount = 0;
        if (this.#transport?.connected) {
          this.#transport.sendJSON({ type: "interrupt" });
        }
      }
    } else {
      this.#interruptChunkCount = 0;
    }

    // Silence detection
    if (rms > this.#silenceThreshold) {
      if (!this.#isSpeaking) {
        this.#isSpeaking = true;
        // Notify server that speech started (for streaming STT)
        if (this.#transport?.connected) {
          this.#transport.sendJSON({ type: "start_of_speech" });
        }
      }
      if (this.#silenceTimer) {
        clearTimeout(this.#silenceTimer);
        this.#silenceTimer = null;
      }
    } else if (this.#isSpeaking) {
      if (!this.#silenceTimer) {
        this.#silenceTimer = setTimeout(() => {
          this.#isSpeaking = false;
          this.#silenceTimer = null;
          if (this.#transport?.connected) {
            this.#transport.sendJSON({ type: "end_of_speech" });
          }
        }, this.#silenceDurationMs);
      }
    }
  }

  #resetDetection(): void {
    if (this.#silenceTimer) {
      clearTimeout(this.#silenceTimer);
      this.#silenceTimer = null;
    }
    this.#isSpeaking = false;
    this.#interruptChunkCount = 0;
    this.#audioLevel = 0;
    this.#emit("audiolevelchange", 0);
  }
}
