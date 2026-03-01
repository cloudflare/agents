/**
 * Shared types for the voice pipeline.
 *
 * Used by both the server (voice.ts) and client (voice-client.ts)
 * to ensure protocol consistency.
 */

// --- Protocol version ---

/**
 * Current voice protocol version.
 * Bump this when making backwards-incompatible wire protocol changes.
 * The server sends this in the initial `welcome` message so clients
 * can detect version mismatches.
 */
export const VOICE_PROTOCOL_VERSION = 1;

// --- Voice status ---

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

// --- Audio format ---

/** Audio format the server uses for binary audio payloads. */
export type VoiceAudioFormat = "mp3" | "pcm16" | "wav" | "opus";

// --- Conversation message role ---

export type VoiceRole = "user" | "assistant";

// --- Wire protocol: Client → Server ---

export type VoiceClientMessage =
  | { type: "hello"; protocol_version?: number }
  | { type: "start_call"; preferred_format?: VoiceAudioFormat }
  | { type: "end_call" }
  | { type: "start_of_speech" }
  | { type: "end_of_speech" }
  | { type: "interrupt" }
  | { type: "text_message"; text: string };

// --- Wire protocol: Server → Client ---

export type VoiceServerMessage =
  | { type: "welcome"; protocol_version: number }
  | { type: "status"; status: VoiceStatus }
  | { type: "audio_config"; format: VoiceAudioFormat; sampleRate?: number }
  | { type: "transcript"; role: VoiceRole; text: string }
  | { type: "transcript_start"; role: VoiceRole }
  | { type: "transcript_delta"; text: string }
  | { type: "transcript_end"; text: string }
  | { type: "transcript_interim"; text: string }
  | {
      type: "metrics";
      vad_ms: number;
      stt_ms: number;
      llm_ms: number;
      tts_ms: number;
      first_audio_ms: number;
      total_ms: number;
    }
  | { type: "error"; message: string };

// --- Pipeline metrics (structured form for consumers) ---

export interface VoicePipelineMetrics {
  vad_ms: number;
  stt_ms: number;
  llm_ms: number;
  tts_ms: number;
  first_audio_ms: number;
  total_ms: number;
}

// --- Transcript message (client-side enriched form) ---

export interface TranscriptMessage {
  role: VoiceRole;
  text: string;
  timestamp: number;
}

// --- Provider interfaces ---

export interface STTProvider {
  transcribe(audioData: ArrayBuffer, signal?: AbortSignal): Promise<string>;
}

export interface TTSProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null>;
}

export interface StreamingTTSProvider {
  synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer>;
}

export interface VADProvider {
  checkEndOfTurn(
    audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }>;
}

// --- Streaming STT ---

/**
 * Streaming speech-to-text provider.
 *
 * Unlike the batch `STTProvider`, this transcribes audio incrementally
 * as it arrives, producing interim and final results in real time.
 * This eliminates STT latency from the critical path — by the time
 * the user stops speaking, the transcript is already (nearly) ready.
 *
 * Session lifecycle is per-utterance: one session per speech segment.
 */
export interface StreamingSTTProvider {
  /** Create a new transcription session for one utterance. */
  createSession(options?: StreamingSTTSessionOptions): StreamingSTTSession;
}

export interface StreamingSTTSessionOptions {
  /** Language code (e.g. "en"). */
  language?: string;
  /** Abort signal — aborted on interrupt or disconnect. */
  signal?: AbortSignal;
}

export interface StreamingSTTSession {
  /**
   * Feed raw PCM audio (16kHz mono 16-bit LE).
   * Fire-and-forget — the session buffers internally as needed.
   */
  feed(chunk: ArrayBuffer): void;

  /**
   * Signal that the speaker has finished.
   * Flushes any buffered audio and returns the final, stable transcript.
   * The session is closed after this call and cannot be reused.
   */
  finish(): Promise<string>;

  /**
   * Called when the provider produces an interim (unstable) transcript.
   * This text may change as more audio arrives.
   */
  onInterim: ((text: string) => void) | null;

  /**
   * Called when the provider finalizes a transcript segment.
   * This text is stable and will not change.
   * A single utterance may produce multiple onFinal calls
   * (e.g. the provider segments by clause or sentence).
   */
  onFinal: ((text: string) => void) | null;

  /**
   * Abort the session and release resources immediately.
   * No final transcript is produced. Used on interrupt/disconnect.
   */
  abort(): void;
}

// --- Audio input ---

/**
 * Pluggable audio input source for VoiceClient.
 *
 * When provided via `VoiceClientOptions.audioInput`, VoiceClient delegates
 * mic capture to this object instead of using its built-in AudioWorklet.
 * The audio input is responsible for capturing audio and routing it to the
 * server (however it chooses — WebRTC, SFU, direct binary, etc.).
 *
 * It must call `onAudioLevel` with RMS values so VoiceClient can run
 * silence detection, interrupt detection, and update the audio level UI.
 *
 * @example
 * ```typescript
 * class SFUAudioInput implements VoiceAudioInput {
 *   onAudioLevel: ((rms: number) => void) | null = null;
 *   async start() {
 *     // Set up WebRTC peer connection, SFU session, etc.
 *     // In a monitoring loop, call this.onAudioLevel?.(rms)
 *   }
 *   stop() {
 *     // Tear down WebRTC
 *   }
 * }
 * ```
 */
export interface VoiceAudioInput {
  /** Start capturing audio. Called by VoiceClient on startCall(). */
  start(): Promise<void>;
  /** Stop capturing audio. Called by VoiceClient on endCall() or disconnect(). */
  stop(): void;
  /**
   * Set by VoiceClient before start(). The audio input must call this
   * with RMS audio level values on each frame so VoiceClient can run
   * silence detection, interrupt detection, and update the UI.
   */
  onAudioLevel: ((rms: number) => void) | null;
}

// --- Voice transport ---

/**
 * Abstraction over the data channel between client and server.
 * The default implementation wraps PartySocket (WebSocket).
 * Implement this interface to use WebRTC, SFU, or other transports.
 */
export interface VoiceTransport {
  /** Send a JSON-serializable message to the server. */
  sendJSON(data: Record<string, unknown>): void;
  /** Send raw binary audio to the server. */
  sendBinary(data: ArrayBuffer): void;

  /** Open the connection. */
  connect(): void;
  /** Close the connection and release resources. */
  disconnect(): void;

  /** Whether the transport is currently connected and ready to send. */
  readonly connected: boolean;

  // --- Event callbacks (set by VoiceClient) ---
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  /** Called when a JSON string message arrives from the server. */
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null;
}
