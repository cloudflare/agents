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
      llm_ms: number;
      tts_ms: number;
      first_audio_ms: number;
      total_ms: number;
    }
  | { type: "error"; message: string };

// --- Pipeline metrics (structured form for consumers) ---

export interface VoicePipelineMetrics {
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

export interface TTSProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null>;
}

export interface StreamingTTSProvider {
  synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer>;
}

// --- Transcriber (continuous per-call STT) ---

/**
 * Continuous speech-to-text provider.
 *
 * Creates a per-call session that receives audio continuously from
 * `start_call` to `end_call`. The model handles turn detection
 * internally — there is no client-side speech boundary signaling
 * required for STT.
 *
 * The session fires `onUtterance` when the model detects a complete
 * utterance (e.g. Flux `EndOfTurn`, Nova 3 `speech_final` +
 * endpointing). The voice pipeline maps this to `onTurn` (withVoice)
 * or `onTranscript` (withVoiceInput).
 */
export interface Transcriber {
  /** Create a new transcription session for one call. */
  createSession(options?: TranscriberSessionOptions): TranscriberSession;
}

export interface TranscriberSessionOptions {
  /** Language code (e.g. "en"). */
  language?: string;
  /**
   * Called when the provider produces an interim (unstable) transcript.
   * This text may change as more audio arrives.
   */
  onInterim?: (text: string) => void;
  /**
   * Called when the model detects a complete utterance.
   * The transcript is the stable text for this turn.
   *
   * For Flux: fires on `EndOfTurn`.
   * For Nova 3: fires on `Results` with `speech_final: true`.
   */
  onUtterance?: (transcript: string) => void;
}

/**
 * A per-call transcription session. Lives for the entire call duration.
 *
 * Unlike per-utterance sessions, this session is never finished or
 * aborted mid-call. It receives all audio continuously and the model
 * handles speech boundary detection. On interrupt, the LLM+TTS
 * pipeline is aborted but the transcriber session stays alive.
 */
export interface TranscriberSession {
  /**
   * Feed raw PCM audio (16kHz mono 16-bit LE).
   * Fire-and-forget — the session buffers internally as needed.
   */
  feed(chunk: ArrayBuffer): void;

  /**
   * Close the session and release resources.
   * Called at end_call or disconnect — not on interrupt.
   */
  close(): void;
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

  /**
   * Set by VoiceClient before start(). If the audio input provides
   * raw PCM audio (16kHz mono 16-bit LE), call this callback and
   * VoiceClient will forward the data to the server via its transport.
   *
   * This is needed when audio reaches the server through the same
   * WebSocket as protocol messages (e.g. SFU in local dev where the
   * SFU adapter can't connect back to localhost).
   *
   * If the audio input routes audio to the server through an external
   * path (e.g. SFU WebSocket adapter in production), this can be left
   * unused — the audio will arrive on a separate connection.
   */
  onAudioData?: ((pcm: ArrayBuffer) => void) | null;
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
