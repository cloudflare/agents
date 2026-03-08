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
}

/** Maps each event name to the data type passed to its listeners. */
export interface VoiceClientEventMap {
  statuschange: VoiceStatus;
  transcriptchange: TranscriptMessage[];
  interimtranscript: string | null;
  metricschange: VoicePipelineMetrics | null;
  audiolevelchange: number;
  connectionchange: boolean;
  error: string | null;
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
  #options: { agent: string; name?: string; host?: string };

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  constructor(options: { agent: string; name?: string; host?: string }) {
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
      prefix: "agents"
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
  #activeSource: AudioBufferSourceNode | null = null;
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

  // --- Connection ---

  connect(): void {
    if (this.#transport) return;

    const transport =
      this.#options.transport ??
      new WebSocketVoiceTransport({
        agent: this.#options.agent,
        name: this.#options.name,
        host: this.#options.host
      });

    transport.onopen = () => {
      console.log(`[VoiceClient] transport opened`);
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
      console.log(`[VoiceClient] transport closed`);
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
        console.log(`[VoiceClient] <<< recv audio Blob: ${data.size} bytes`);
        data.arrayBuffer().then((buffer) => {
          this.#playbackQueue.push(buffer);
          this.#processPlaybackQueue();
        });
      } else if (data instanceof ArrayBuffer) {
        console.log(
          `[VoiceClient] <<< recv audio ArrayBuffer: ${data.byteLength} bytes`
        );
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
    console.log(
      `[VoiceClient] startCall() called, transport connected=${this.#transport?.connected}`
    );
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
    console.log(`[VoiceClient] endCall() called`);
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
    this.#activeSource?.stop();
    this.#activeSource = null;
    this.#playbackQueue = [];
    this.#isPlaying = false;
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

    console.log(`[VoiceClient] <<< recv JSON: ${msg.type}`, msg);
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
      case "transcript":
        // Final transcript arrived — clear interim
        this.#interimTranscript = null;
        this.#emit("interimtranscript", null);
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
          vad_ms: msg.vad_ms as number,
          stt_ms: msg.stt_ms as number,
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
      this.#audioContext.close().catch(() => {});
      this.#audioContext = null;
      this.#workletRegistered = false;
    }
  }

  // --- Audio playback ---

  async #playAudio(audioData: ArrayBuffer): Promise<void> {
    try {
      console.log(
        `[VoiceClient] playing audio: ${audioData.byteLength} bytes, format=${this.#audioFormat}`
      );
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

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      this.#activeSource = source;

      return new Promise<void>((resolve) => {
        source.onended = () => {
          if (this.#activeSource === source) {
            this.#activeSource = null;
          }
          resolve();
        };
        source.start();
      });
    } catch (err) {
      console.error("[VoiceClient] Audio playback error:", err);
    }
  }

  async #processPlaybackQueue(): Promise<void> {
    if (this.#isPlaying || this.#playbackQueue.length === 0) return;
    this.#isPlaying = true;

    while (this.#playbackQueue.length > 0) {
      const audioData = this.#playbackQueue.shift()!;
      await this.#playAudio(audioData);
    }

    this.#isPlaying = false;
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

  // Throttle audio level logs — only log every Nth call to avoid flooding
  #audioLevelLogCounter = 0;

  #processAudioLevel(rms: number): void {
    // When muted, ignore incoming audio levels. This prevents false
    // speech detection when a custom audioInput keeps reporting levels.
    // The built-in mic already gates on !#isMuted before calling here,
    // but audioInput implementations don't know about mute state.
    if (this.#isMuted) return;

    this.#audioLevel = rms;
    this.#emit("audiolevelchange", rms);

    // Log every 50th audio level for trend visibility
    this.#audioLevelLogCounter++;
    if (this.#audioLevelLogCounter % 50 === 0) {
      console.log(
        `[VoiceClient] audioLevel rms=${rms.toFixed(4)} | silenceThreshold=${this.#silenceThreshold} | isSpeaking=${this.#isSpeaking} | isPlaying=${this.#isPlaying} | status=${this.#status}`
      );
    }

    // Interruption detection: user speaking during agent playback
    if (this.#isPlaying && rms > this.#interruptThreshold) {
      this.#interruptChunkCount++;
      console.log(
        `[VoiceClient] interrupt candidate: rms=${rms.toFixed(4)} > threshold=${this.#interruptThreshold}, count=${this.#interruptChunkCount}/${this.#interruptChunks}`
      );
      if (this.#interruptChunkCount >= this.#interruptChunks) {
        console.log(`[VoiceClient] >>> INTERRUPT triggered`);
        this.#activeSource?.stop();
        this.#activeSource = null;
        this.#playbackQueue = [];
        this.#isPlaying = false;
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
        console.log(
          `[VoiceClient] >>> SPEECH START: rms=${rms.toFixed(4)} > silenceThreshold=${this.#silenceThreshold}`
        );
        this.#isSpeaking = true;
        // Notify server that speech started (for streaming STT)
        if (this.#transport?.connected) {
          console.log(`[VoiceClient] >>> sending start_of_speech`);
          this.#transport.sendJSON({ type: "start_of_speech" });
        }
      }
      if (this.#silenceTimer) {
        clearTimeout(this.#silenceTimer);
        this.#silenceTimer = null;
      }
    } else if (this.#isSpeaking) {
      if (!this.#silenceTimer) {
        console.log(
          `[VoiceClient] silence detected (rms=${rms.toFixed(4)}), starting ${this.#silenceDurationMs}ms timer`
        );
        this.#silenceTimer = setTimeout(() => {
          console.log(
            `[VoiceClient] >>> SPEECH END: silence timer fired after ${this.#silenceDurationMs}ms`
          );
          this.#isSpeaking = false;
          this.#silenceTimer = null;
          if (this.#transport?.connected) {
            console.log(`[VoiceClient] >>> sending end_of_speech`);
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
