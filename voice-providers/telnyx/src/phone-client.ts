/**
 * Standalone voice client for PSTN phone calls via TelnyxCallBridge.
 *
 * Speaks the Cloudflare voice protocol directly over any VoiceTransport,
 * routing audio through a TelnyxCallBridge instead of browser speakers.
 * Provides the same detection, transcript, and event features as
 * VoiceClient from @cloudflare/voice/client — ported for phone use.
 *
 * **Why not VoiceClient?**
 * VoiceClient plays received audio through the browser's AudioContext.
 * For phone calls, audio must go to the bridge (WebRTC → PSTN), not
 * speakers. VoiceClient has no hook to redirect this. TelnyxPhoneClient
 * gives full control over both audio directions.
 *
 * **Server requirement:** Use `audioFormat: "pcm16"` in your server-side
 * VoiceAgentOptions so audio arrives as 16kHz mono Int16 LE — the format
 * TelnyxCallBridge.playAudio() expects.
 *
 * @example
 * ```typescript
 * import { WebSocketVoiceTransport } from "@cloudflare/voice/client";
 * import { TelnyxPhoneClient, createTelnyxVoiceConfig } from "@cloudflare/voice-telnyx";
 *
 * const telnyx = await createTelnyxVoiceConfig({
 *   jwtEndpoint: "/api/telnyx-token",
 *   autoAnswer: true,
 * });
 *
 * const client = new TelnyxPhoneClient({
 *   transport: new WebSocketVoiceTransport({ agent: "my-voice-agent" }),
 *   bridge: telnyx.bridge,
 * });
 *
 * client.addEventListener("statuschange", (s) => console.log("status:", s));
 * client.connect();
 * client.addEventListener("connectionchange", async (connected) => {
 *   if (connected) await client.startCall();
 * });
 * ```
 */

import type {
  VoiceTransport,
  VoiceStatus,
  VoiceAudioFormat,
  VoiceRole,
  TranscriptMessage,
  VoicePipelineMetrics
} from "@cloudflare/voice/client";
import type { TelnyxCallBridge } from "./providers/call-bridge.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TelnyxPhoneClientConfig {
  /** The transport for server communication (e.g. WebSocketVoiceTransport). */
  transport: VoiceTransport;
  /** The call bridge for PSTN audio I/O. */
  bridge: TelnyxCallBridge;
  /**
   * Preferred audio format sent to the server in `start_call`.
   * Must be `"pcm16"` for TelnyxCallBridge compatibility.
   * @default "pcm16"
   */
  preferredFormat?: VoiceAudioFormat;
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

export interface TelnyxPhoneClientEventMap {
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

export type TelnyxPhoneClientEvent = keyof TelnyxPhoneClientEventMap;

// ─── Implementation ─────────────────────────────────────────────────────────

export class TelnyxPhoneClient {
  // ── Public state (read via getters) ────────────────────────────────────
  private _status: VoiceStatus = "idle";
  private _transcript: TranscriptMessage[] = [];
  private _metrics: VoicePipelineMetrics | null = null;
  private _audioLevel = 0;
  private _isMuted = false;
  private _connected = false;
  private _error: string | null = null;
  private _interimTranscript: string | null = null;
  private _lastCustomMessage: unknown = null;
  private _audioFormat: VoiceAudioFormat | null = null;
  private _serverProtocolVersion: number | null = null;

  // ── Internal state ─────────────────────────────────────────────────────
  private inCall = false;
  private isPlaying = false;
  private isSpeaking = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptChunkCount = 0;
  private warnedFormat = false;
  private listeners = new Map<string, Set<Function>>();

  // ── Config ─────────────────────────────────────────────────────────────
  private transport: VoiceTransport;
  private bridge: TelnyxCallBridge;
  private preferredFormat: VoiceAudioFormat;
  private silenceThreshold: number;
  private silenceDurationMs: number;
  private interruptThreshold: number;
  private interruptChunks: number;
  private maxTranscriptMessages: number;

  constructor(config: TelnyxPhoneClientConfig) {
    this.transport = config.transport;
    this.bridge = config.bridge;
    this.preferredFormat = config.preferredFormat ?? "pcm16";
    this.silenceThreshold = config.silenceThreshold ?? 0.04;
    this.silenceDurationMs = config.silenceDurationMs ?? 500;
    this.interruptThreshold = config.interruptThreshold ?? 0.05;
    this.interruptChunks = config.interruptChunks ?? 2;
    this.maxTranscriptMessages = config.maxTranscriptMessages ?? 200;
  }

  // ─── Getters ──────────────────────────────────────────────────────────

  get status(): VoiceStatus {
    return this._status;
  }
  get transcript(): TranscriptMessage[] {
    return this._transcript;
  }
  get metrics(): VoicePipelineMetrics | null {
    return this._metrics;
  }
  get audioLevel(): number {
    return this._audioLevel;
  }
  get isMuted(): boolean {
    return this._isMuted;
  }
  get connected(): boolean {
    return this._connected;
  }
  get error(): string | null {
    return this._error;
  }
  get interimTranscript(): string | null {
    return this._interimTranscript;
  }
  get lastCustomMessage(): unknown {
    return this._lastCustomMessage;
  }
  get audioFormat(): VoiceAudioFormat | null {
    return this._audioFormat;
  }
  get serverProtocolVersion(): number | null {
    return this._serverProtocolVersion;
  }

  // ─── Events ───────────────────────────────────────────────────────────

  addEventListener<K extends TelnyxPhoneClientEvent>(
    event: K,
    listener: (data: TelnyxPhoneClientEventMap[K]) => void
  ): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  removeEventListener<K extends TelnyxPhoneClientEvent>(
    event: K,
    listener: (data: TelnyxPhoneClientEventMap[K]) => void
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit<K extends TelnyxPhoneClientEvent>(
    event: K,
    data: TelnyxPhoneClientEventMap[K]
  ): void {
    const set = this.listeners.get(event);
    if (set) for (const fn of set) (fn as Function)(data);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** Open the transport connection and send the protocol handshake. */
  connect(): void {
    this.transport.onopen = () => {
      this._connected = true;
      this._error = null;
      this.transport.sendJSON({ type: "hello", protocol_version: 1 });
      this.emit("connectionchange", true);
      this.emit("error", null);
      // If we were already in a call when reconnecting, re-send start_call
      if (this.inCall) this.transport.sendJSON({ type: "start_call" });
    };

    this.transport.onclose = () => {
      this._connected = false;
      this.emit("connectionchange", false);
    };

    this.transport.onerror = () => {
      this._error = "Connection lost. Reconnecting...";
      this.emit("error", this._error);
    };

    this.transport.onmessage = (data) => {
      if (typeof data === "string") {
        this.handleJSON(data);
      } else if (data instanceof ArrayBuffer) {
        this.handleAudio(data);
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => this.handleAudio(buf));
      }
    };

    this.transport.connect();
  }

  /** End any active call, then close the transport. */
  disconnect(): void {
    this.endCall();
    this.transport.disconnect();
    this._connected = false;
    this.emit("connectionchange", false);
  }

  /**
   * Start a voice call. Wires up the bridge audio callbacks,
   * starts the bridge, and sends `start_call` to the server.
   *
   * The bridge's `start()` is called here — do not call it separately.
   */
  async startCall(): Promise<void> {
    if (!this.transport.connected) {
      this._error = "Cannot start call: not connected. Call connect() first.";
      this.emit("error", this._error);
      return;
    }

    this.inCall = true;
    this._error = null;
    this._metrics = null;
    this.emit("error", null);
    this.emit("metricschange", null);

    const startMsg: Record<string, unknown> = { type: "start_call" };
    if (this.preferredFormat) startMsg.preferred_format = this.preferredFormat;
    this.transport.sendJSON(startMsg);

    // Wire bridge → server audio pipeline
    this.bridge.onAudioLevel = (rms) => this.processAudioLevel(rms);
    this.bridge.onAudioData = (pcm) => {
      if (this.transport.connected && !this._isMuted) {
        this.transport.sendBinary(pcm);
      }
    };

    await this.bridge.start();
  }

  /**
   * End the voice call. Detaches audio callbacks from the bridge
   * and sends `end_call` to the server.
   *
   * Does NOT stop the bridge or hang up the phone — call
   * `bridge.stop()` or `cleanup()` separately for that.
   */
  endCall(): void {
    this.inCall = false;

    if (this.transport.connected) {
      this.transport.sendJSON({ type: "end_call" });
    }

    // Detach bridge callbacks but don't stop the bridge itself —
    // the phone call may need to continue independently.
    this.bridge.onAudioLevel = null;
    if (this.bridge.onAudioData !== undefined) {
      this.bridge.onAudioData = null;
    }

    this.isPlaying = false;
    this.resetDetection();
    this._status = "idle";
    this.emit("statuschange", "idle");
  }

  /** Toggle mute. When muted, audio is not sent to the server. */
  toggleMute(): void {
    this._isMuted = !this._isMuted;

    if (this._isMuted) {
      this._audioLevel = 0;
      this.emit("audiolevelchange", 0);
    }

    // If muted while speaking, end the speech boundary
    if (this._isMuted && this.isSpeaking) {
      this.isSpeaking = false;
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      if (this.transport.connected) {
        this.transport.sendJSON({ type: "end_of_speech" });
      }
    }

    this.emit("mutechange", this._isMuted);
  }

  /** Send a text message to the agent (bypasses STT, goes to onTurn). */
  sendText(text: string): void {
    if (this.transport.connected) {
      this.transport.sendJSON({ type: "text_message", text });
    }
  }

  /** Send arbitrary JSON to the agent (app-level messages). */
  sendJSON(data: Record<string, unknown>): void {
    if (this.transport.connected) this.transport.sendJSON(data);
  }

  // ─── Server Message Handling ──────────────────────────────────────────

  private handleJSON(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "welcome":
        this._serverProtocolVersion = msg.protocol_version as number;
        if (msg.protocol_version !== 1) {
          console.warn(
            `[TelnyxPhoneClient] Protocol version mismatch: ` +
              `client=1, server=${msg.protocol_version}`
          );
        }
        break;

      case "audio_config":
        this._audioFormat = msg.format as VoiceAudioFormat;
        this.warnedFormat = false;
        break;

      case "status":
        this._status = msg.status as VoiceStatus;
        // Track server-side playback state for interrupt detection
        this.isPlaying = msg.status === "speaking";
        if (msg.status === "listening" || msg.status === "idle") {
          this._error = null;
          this.emit("error", null);
        }
        this.emit("statuschange", this._status);
        break;

      case "transcript_interim":
        this._interimTranscript = msg.text as string;
        this.emit("interimtranscript", this._interimTranscript);
        break;

      case "transcript": {
        this._interimTranscript = null;
        this.emit("interimtranscript", null);
        // User transcript during playback → clear playback buffer
        if ((msg.role as string) === "user" && this.isPlaying) {
          this.isPlaying = false;
          this.bridge.clearPlaybackBuffer();
        }
        this._transcript = [
          ...this._transcript,
          {
            role: msg.role as VoiceRole,
            text: msg.text as string,
            timestamp: Date.now()
          }
        ];
        this.trimTranscript();
        this.emit("transcriptchange", this._transcript);
        break;
      }

      case "transcript_start":
        this._transcript = [
          ...this._transcript,
          { role: "assistant" as VoiceRole, text: "", timestamp: Date.now() }
        ];
        this.trimTranscript();
        this.emit("transcriptchange", this._transcript);
        break;

      case "transcript_delta": {
        if (this._transcript.length === 0) break;
        const updated = [...this._transcript];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            text: last.text + (msg.text as string)
          };
          this._transcript = updated;
          this.emit("transcriptchange", this._transcript);
        }
        break;
      }

      case "transcript_end": {
        if (this._transcript.length === 0) break;
        const updated = [...this._transcript];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            text: msg.text as string
          };
          this._transcript = updated;
          this.emit("transcriptchange", this._transcript);
        }
        break;
      }

      case "metrics":
        this._metrics = {
          llm_ms: msg.llm_ms as number,
          tts_ms: msg.tts_ms as number,
          first_audio_ms: msg.first_audio_ms as number,
          total_ms: msg.total_ms as number
        };
        this.emit("metricschange", this._metrics);
        break;

      case "error":
        this._error = msg.message as string;
        this.emit("error", this._error);
        break;

      default:
        this._lastCustomMessage = msg;
        this.emit("custommessage", msg);
        break;
    }
  }

  private handleAudio(audio: ArrayBuffer): void {
    if (this._audioFormat === "pcm16" || this._audioFormat === null) {
      this.bridge.playAudio(audio);
    } else {
      // Non-PCM format (mp3, wav, opus) — decode to PCM16 via AudioContext
      this.decodeAndPlay(audio);
    }
  }

  private decodeContext: AudioContext | null = null;

  private async decodeAndPlay(audio: ArrayBuffer): Promise<void> {
    try {
      if (!this.decodeContext) {
        this.decodeContext = new AudioContext({ sampleRate: 16000 });
      }
      const decoded = await this.decodeContext.decodeAudioData(audio.slice(0));
      const float32 = decoded.getChannelData(0);
      // Convert float32 → Int16 PCM
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.bridge.playAudio(int16.buffer as ArrayBuffer);
    } catch (err) {
      if (!this.warnedFormat) {
        this.warnedFormat = true;
        console.warn(
          `[TelnyxPhoneClient] Failed to decode "${this._audioFormat}" audio:`,
          err
        );
      }
    }
  }

  // ─── Silence & Interrupt Detection ────────────────────────────────────
  //
  // Ported from VoiceClient (@cloudflare/voice/client).
  // Same thresholds, same logic, same protocol messages.

  private processAudioLevel(rms: number): void {
    if (this._isMuted) return;

    this._audioLevel = rms;
    this.emit("audiolevelchange", rms);

    // ── Interrupt detection ──
    // If the agent is speaking and the caller talks over it,
    // send an interrupt to stop the agent response.
    if (this.isPlaying && rms > this.interruptThreshold) {
      this.interruptChunkCount++;
      if (this.interruptChunkCount >= this.interruptChunks) {
        this.isPlaying = false;
        this.interruptChunkCount = 0;
        this.bridge.clearPlaybackBuffer();
        if (this.transport.connected) {
          this.transport.sendJSON({ type: "interrupt" });
        }
      }
    } else {
      this.interruptChunkCount = 0;
    }

    // ── Speech boundary detection ──
    // Detect when the user starts/stops speaking and signal the server.
    if (rms > this.silenceThreshold) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        if (this.transport.connected) {
          this.transport.sendJSON({ type: "start_of_speech" });
        }
      }
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
    } else if (this.isSpeaking) {
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.isSpeaking = false;
          this.silenceTimer = null;
          if (this.transport.connected) {
            this.transport.sendJSON({ type: "end_of_speech" });
          }
        }, this.silenceDurationMs);
      }
    }
  }

  private resetDetection(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.isSpeaking = false;
    this.interruptChunkCount = 0;
    this._audioLevel = 0;
    this.emit("audiolevelchange", 0);
  }

  private trimTranscript(): void {
    if (this._transcript.length > this.maxTranscriptMessages) {
      this._transcript = this._transcript.slice(-this.maxTranscriptMessages);
    }
  }
}
