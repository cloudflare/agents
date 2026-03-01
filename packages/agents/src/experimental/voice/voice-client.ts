import { PartySocket } from "partysocket";
import { camelCaseToKebabCase } from "../../utils";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
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
  VoiceTransport,
  TranscriptMessage
} from "./types";

// Backward-compatible alias
export type PipelineMetrics = VoicePipelineMetrics;

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

  // Tuning knobs with sensible defaults
  /** RMS threshold below which audio is considered silence. @default 0.01 */
  silenceThreshold?: number;
  /** How long silence must last before sending end_of_speech (ms). @default 500 */
  silenceDurationMs?: number;
  /** RMS threshold for detecting user speech during agent playback. @default 0.02 */
  interruptThreshold?: number;
  /** Consecutive high-RMS chunks needed to trigger an interrupt. @default 2 */
  interruptChunks?: number;
  /** Maximum transcript messages to keep in memory. @default 200 */
  maxTranscriptMessages?: number;
}

export type VoiceClientEvent =
  | "statuschange"
  | "transcriptchange"
  | "interimtranscript"
  | "metricschange"
  | "audiolevelchange"
  | "connectionchange"
  | "error"
  | "mutechange"
  | "custommessage";

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

type Listener = () => void;

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
  #listeners = new Map<VoiceClientEvent, Set<Listener>>();

  constructor(options: VoiceClientOptions) {
    this.#options = options;
    this.#silenceThreshold = options.silenceThreshold ?? 0.01;
    this.#silenceDurationMs = options.silenceDurationMs ?? 500;
    this.#interruptThreshold = options.interruptThreshold ?? 0.02;
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

  addEventListener(event: VoiceClientEvent, listener: Listener): void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
  }

  removeEventListener(event: VoiceClientEvent, listener: Listener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  #emit(event: VoiceClientEvent): void {
    const set = this.#listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener();
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
      this.#connected = true;
      this.#error = null;
      // Announce our protocol version to the server
      transport.sendJSON({
        type: "hello",
        protocol_version: VOICE_PROTOCOL_VERSION
      });
      this.#emit("connectionchange");
      this.#emit("error");

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
      this.#emit("connectionchange");
    };

    transport.onerror = () => {
      this.#error = "Connection lost. Reconnecting...";
      this.#emit("error");
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
    this.#emit("connectionchange");
  }

  // --- Public actions ---

  async startCall(): Promise<void> {
    if (this.#transport?.connected) {
      this.#inCall = true;
      this.#error = null;
      this.#metrics = null;
      this.#emit("error");
      this.#emit("metricschange");
      this.#transport.sendJSON({ type: "start_call" });
      await this.#startMic();
    }
  }

  endCall(): void {
    this.#inCall = false;
    if (this.#transport?.connected) {
      this.#transport.sendJSON({ type: "end_call" });
    }
    this.#stopMic();
    this.#activeSource?.stop();
    this.#activeSource = null;
    this.#playbackQueue = [];
    this.#isPlaying = false;
    this.#closeAudioContext();
    this.#status = "idle";
    this.#emit("statuschange");
  }

  toggleMute(): void {
    this.#isMuted = !this.#isMuted;
    this.#emit("mutechange");
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
   * The server receives these in `onMessage()` / `onNonVoiceMessage()`.
   */
  send(data: Record<string, unknown>): void {
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
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "welcome":
          this.#serverProtocolVersion = msg.protocol_version;
          if (msg.protocol_version !== VOICE_PROTOCOL_VERSION) {
            console.warn(
              `[VoiceClient] Protocol version mismatch: client=${VOICE_PROTOCOL_VERSION}, server=${msg.protocol_version}`
            );
          }
          break;
        case "audio_config":
          this.#audioFormat = msg.format;
          break;
        case "status":
          this.#status = msg.status;
          if (msg.status === "listening" || msg.status === "idle") {
            this.#error = null;
            this.#emit("error");
          }
          this.#emit("statuschange");
          break;
        case "transcript_interim":
          this.#interimTranscript = msg.text;
          this.#emit("interimtranscript");
          break;
        case "transcript":
          // Final transcript arrived — clear interim
          this.#interimTranscript = null;
          this.#emit("interimtranscript");
          this.#transcript = [
            ...this.#transcript,
            { role: msg.role, text: msg.text, timestamp: Date.now() }
          ];
          this.#trimTranscript();
          this.#emit("transcriptchange");
          break;
        case "transcript_start":
          this.#transcript = [
            ...this.#transcript,
            { role: "assistant", text: "", timestamp: Date.now() }
          ];
          this.#trimTranscript();
          this.#emit("transcriptchange");
          break;
        case "transcript_delta": {
          if (this.#transcript.length === 0) break;
          const updated = [...this.#transcript];
          const last = updated[updated.length - 1];
          if (last.role === "assistant") {
            updated[updated.length - 1] = {
              ...last,
              text: last.text + msg.text
            };
            this.#transcript = updated;
            this.#emit("transcriptchange");
          }
          break;
        }
        case "transcript_end": {
          if (this.#transcript.length === 0) break;
          const updated = [...this.#transcript];
          const last = updated[updated.length - 1];
          if (last.role === "assistant") {
            updated[updated.length - 1] = { ...last, text: msg.text };
            this.#transcript = updated;
            this.#emit("transcriptchange");
          }
          break;
        }
        case "metrics":
          this.#metrics = {
            vad_ms: msg.vad_ms,
            stt_ms: msg.stt_ms,
            llm_ms: msg.llm_ms,
            tts_ms: msg.tts_ms,
            first_audio_ms: msg.first_audio_ms,
            total_ms: msg.total_ms
          };
          this.#emit("metricschange");
          break;
        case "error":
          this.#error = msg.message;
          this.#emit("error");
          break;
        default:
          // App-level custom message — surface via event
          this.#lastCustomMessage = msg;
          this.#emit("custommessage");
          break;
      }
    } catch {
      // ignore non-JSON messages (state sync etc.)
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
          this.#audioLevel = rms;
          this.#emit("audiolevelchange");

          // Send PCM to agent
          const pcm = floatTo16BitPCM(samples);
          if (this.#transport?.connected) {
            this.#transport.sendBinary(pcm);
          }

          // Interruption detection: user speaking during agent playback
          if (this.#isPlaying && rms > this.#interruptThreshold) {
            this.#interruptChunkCount++;
            if (this.#interruptChunkCount >= this.#interruptChunks) {
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
      };

      source.connect(workletNode);
      workletNode.connect(ctx.destination);
    } catch (err) {
      console.error("[VoiceClient] Mic error:", err);
      this.#error =
        "Microphone access denied. Please allow microphone access and try again.";
      this.#emit("error");
    }
  }

  #stopMic(): void {
    this.#workletNode?.disconnect();
    this.#workletNode = null;
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    if (this.#silenceTimer) {
      clearTimeout(this.#silenceTimer);
      this.#silenceTimer = null;
    }
    this.#isSpeaking = false;
    this.#audioLevel = 0;
    this.#emit("audiolevelchange");
  }
}
