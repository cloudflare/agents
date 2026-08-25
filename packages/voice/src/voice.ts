/**
 * Voice pipeline mixin for the Agents SDK.
 *
 * Usage:
 *   import { Agent } from "agents";
 *   import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
 *
 *   const VoiceAgent = withVoice(Agent);
 *
 *   class MyAgent extends VoiceAgent<Env> {
 *     transcriber = new WorkersAIFluxSTT(this.env.AI);
 *     tts = new WorkersAITTS(this.env.AI);
 *
 *     async onTurn(transcript, context) {
 *       const result = streamText({ ... });
 *       return result.stream;
 *     }
 *   }
 *
 * This mixin adds the full voice pipeline: continuous STT, streaming TTS,
 * interruption handling, conversation persistence, and the WebSocket
 * voice protocol. The transcriber session is per-call — created at
 * start_call, closed at end_call. The model handles turn detection.
 *
 * @experimental This API is not yet stable and may change.
 */

import type { Agent, Connection, WSMessage } from "agents";
import { SentenceChunker } from "./sentence-chunker";
import { logVoiceError, toVoiceError, voiceErrorMessage } from "./errors";
import {
  ServerDiagnostics,
  type DiagnosticData,
  type ModelDiagnosticTracker,
  type TurnDiagnostics
} from "./diagnostics";
import {
  iterateTextEvents,
  type TextSource,
  type TextStreamEvent
} from "./text-stream";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type {
  VoiceRole,
  VoiceAudioFormat,
  TTSProvider,
  StreamingTTSProvider,
  Transcriber,
  TranscriberSession,
  VoiceCompletionOutcome,
  VoiceModelFinishReason,
  VoiceDiagnosticsOptions,
  VoiceTurnOutcome
} from "./types";
import {
  AudioConnectionManager,
  runBackground,
  sendVoiceJSON
} from "./audio-pipeline";

// Re-export SentenceChunker for direct use
export { SentenceChunker } from "./sentence-chunker";

// Re-export protocol version constant
export { VOICE_PROTOCOL_VERSION } from "./types";

// Re-export shared types
export type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceTransport,
  VoiceTransportCloseInfo,
  VoiceError,
  VoiceErrorCode,
  VoiceErrorStage,
  VoiceCompletionOutcome,
  VoiceCompletionOutcomeCode,
  VoiceModelFinishReason,
  VoiceDiagnosticsOptions,
  VoiceDiagnosticEvent,
  VoiceTurnMetrics,
  VoiceTurnOutcome,
  VoiceTurnSource,
  VoiceClientMessage,
  VoiceServerMessage,
  VoicePipelineMetrics,
  TranscriptMessage,
  TTSProvider,
  StreamingTTSProvider,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "./types";

// Re-export voice input mixin (STT-only, no TTS/LLM)
export { withVoiceInput, type VoiceInputOptions } from "./voice-input";

// Re-export text stream utility
export { iterateText, type TextSource } from "./text-stream";

// Re-export SFU utility functions
export {
  decodeVarint,
  encodeVarint,
  extractPayloadFromProtobuf,
  encodePayloadToProtobuf,
  downsample48kStereoTo16kMono,
  upsample16kMonoTo48kStereo,
  sfuFetch,
  createSFUSession,
  addSFUTracks,
  renegotiateSFUSession,
  createSFUWebSocketAdapter
} from "./sfu-utils";
export type { SFUConfig } from "./sfu-utils";

// Re-export Workers AI providers
export {
  WorkersAITTS,
  WorkersAIFluxSTT,
  WorkersAINova3STT
} from "./workers-ai-providers";
export type {
  WorkersAITTSOptions,
  WorkersAIFluxSTTOptions,
  WorkersAINova3STTOptions
} from "./workers-ai-providers";

// --- Public types ---

/** Context passed to the `onTurn()` hook. */
export interface VoiceTurnContext {
  connection: Connection;
  /** Completed conversation history before the current transcript. */
  messages: Array<{ role: VoiceRole; content: string }>;
  signal: AbortSignal;
}

/** Configuration options for the voice mixin. Passed to `withVoice()`. */
export interface VoiceAgentOptions {
  /** Max conversation history messages loaded for context. @default 20 */
  historyLimit?: number;
  /** Audio format used for binary audio payloads sent to the client. @default "mp3" */
  audioFormat?: VoiceAudioFormat;
  /**
   * Sample rate (Hz) of raw PCM audio payloads sent to the client.
   * Declared in the `audio_config` message so the client can play `pcm16`
   * at the provider's native rate (e.g. 24000 for Gemini TTS).
   * Encoded formats (mp3/wav/opus) carry their own rate and ignore this.
   * @default 16000
   */
  sampleRate?: number;
  /** Max conversation messages to keep in SQLite. Oldest are pruned. @default 1000 */
  maxMessageCount?: number;
  /** Optional diagnostic output. Diagnostic event names and metadata are not stable API. */
  diagnostics?: VoiceDiagnosticsOptions;
}

// --- Default option values ---

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_COUNT = 1000;
const DEFAULT_SAMPLE_RATE = 16000;

class ModelStreamError extends Error {
  readonly streamError: Error;
  readonly partialOutput: boolean;

  constructor(streamError: Error, partialOutput: boolean) {
    super(streamError.message, { cause: streamError });
    this.name = "ModelStreamError";
    this.streamError = streamError;
    this.partialOutput = partialOutput;
  }
}

function completionOutcomeCode(
  finishReason: VoiceModelFinishReason | undefined,
  hasOutput: boolean
): VoiceCompletionOutcome["code"] | null {
  if (finishReason === "length") return "output_limit";
  if (finishReason === "content-filter") return "content_filtered";
  if (finishReason === "error") return "model_error";
  return hasOutput ? null : "no_output";
}

function stableTurnOutcome(
  finishReason: VoiceModelFinishReason | undefined,
  hasOutput: boolean
): VoiceTurnOutcome {
  return completionOutcomeCode(finishReason, hasOutput) ?? "completed";
}

function createCompletionOutcome(
  finishReason: VoiceModelFinishReason | undefined,
  partialOutput: boolean
): VoiceCompletionOutcome | null {
  const code = completionOutcomeCode(finishReason, partialOutput);
  return code === null
    ? null
    : {
        code,
        stage: "llm",
        ...(finishReason === undefined ? {} : { finishReason }),
        partialOutput
      };
}

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<
  Pick<Agent<Cloudflare.Env>, "sql" | "getConnections" | "keepAlive">
>;

type ActiveTurnDiagnostics = {
  signal: AbortSignal;
  turn: TurnDiagnostics;
  model?: ModelDiagnosticTracker;
};

/** Public surface of the voice mixin, used as an explicit return type to satisfy TS6 declaration emit. */
export interface VoiceAgentMixinMembers {
  transcriber?: Transcriber;
  tts?: (TTSProvider & Partial<StreamingTTSProvider>) | undefined;
  onTurn(transcript: string, context: VoiceTurnContext): Promise<TextSource>;
  createTranscriber(connection: Connection): Transcriber | null;
  beforeCallStart(connection: Connection): boolean | Promise<boolean>;
  onCallStart(connection: Connection): void | Promise<void>;
  onCallEnd(connection: Connection): void | Promise<void>;
  onInterrupt(connection: Connection): void | Promise<void>;
  afterTranscribe(
    transcript: string,
    connection: Connection
  ): string | null | Promise<string | null>;
  beforeSynthesize(
    text: string,
    connection: Connection
  ): string | null | Promise<string | null>;
  afterSynthesize(
    audio: ArrayBuffer | null,
    text: string,
    connection: Connection
  ): ArrayBuffer | null | Promise<ArrayBuffer | null>;
  saveMessage(role: "user" | "assistant", text: string): void;
  getConversationHistory(
    limit?: number
  ): Array<{ role: VoiceRole; content: string }>;
  forceEndCall(connection: Connection): void;
  speak(connection: Connection, text: string): Promise<void>;
  speakAll(text: string): Promise<void>;
}

type VoiceAgentMixinReturn<TBase extends AgentLike> = TBase &
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
  (new (...args: any[]) => VoiceAgentMixinMembers);

/**
 * Voice pipeline mixin. Adds the full voice pipeline to an Agent class.
 *
 * Subclasses must set a `transcriber` property (or override `createTranscriber`)
 * and a `tts` provider property. The transcriber session is per-call — created
 * at start_call and closed at end_call. The model handles turn detection.
 *
 * @param Base - The Agent class to extend (e.g. `Agent`).
 * @param voiceOptions - Optional pipeline configuration.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * class MyAgent extends VoiceAgent<Env> {
 *   transcriber = new WorkersAIFluxSTT(this.env.AI);
 *   tts = new WorkersAITTS(this.env.AI);
 *
 *   async onTurn(transcript, context) {
 *     return "Hello! I heard you say: " + transcript;
 *   }
 * }
 * ```
 */
export function withVoice<TBase extends AgentLike>(
  Base: TBase,
  voiceOptions?: VoiceAgentOptions
): VoiceAgentMixinReturn<TBase> {
  const opts = voiceOptions ?? {};
  const diagnostics = new ServerDiagnostics(
    opts.diagnostics?.browserConsole === true
  );

  function opt<K extends keyof VoiceAgentOptions>(
    key: K,
    fallback: NonNullable<VoiceAgentOptions[K]>
  ): NonNullable<VoiceAgentOptions[K]> {
    return (opts[key] ?? fallback) as NonNullable<VoiceAgentOptions[K]>;
  }

  class VoiceAgentMixin extends Base {
    // --- Provider properties (set by subclass) ---

    /** Continuous transcriber provider. */
    transcriber?: Transcriber;
    /** Text-to-speech provider. Required. May also implement StreamingTTSProvider. */
    tts?: TTSProvider & Partial<StreamingTTSProvider>;

    // Shared per-connection audio state manager
    #cm = new AudioConnectionManager("VoiceAgent");

    // keepAlive dispose functions per connection (prevents DO eviction during calls)
    #keepAliveDispose = new Map<string, () => void>();

    // Current async start_call identity per connection, used to ignore stale readiness.
    #startupTokens = new Map<string, symbol>();
    // Persists after readiness so callbacks from replaced sessions cannot affect a newer call.
    #callTokens = new Map<string, symbol>();
    #turnSequence = 0;
    #inputTurns = new Map<string, TurnDiagnostics>();
    #activeTurnDiagnostics = new Map<string, ActiveTurnDiagnostics>();

    // Voice protocol message types handled internally
    static #VOICE_MESSAGES = new Set([
      "hello",
      "start_call",
      "end_call",
      "start_of_speech",
      "end_of_speech",
      "interrupt",
      "text_message"
    ]);

    // --- Agent lifecycle ---

    #schemaReady = false;

    #ensureSchema() {
      if (this.#schemaReady) return;
      this.sql`
        CREATE TABLE IF NOT EXISTS cf_voice_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `;
      this.#schemaReady = true;
    }

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
    constructor(...args: any[]) {
      super(...args);

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onConnect = (this as any).onConnect?.bind(this);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onClose = (this as any).onClose?.bind(this);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onMessage = (this as any).onMessage?.bind(this);

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onConnect = (
        connection: Connection,
        ...rest: unknown[]
      ) => {
        this.#sendJSON(connection, {
          type: "welcome",
          protocol_version: VOICE_PROTOCOL_VERSION,
          ...(diagnostics.browserConsole
            ? { diagnostics: { browser_console: true as const } }
            : {})
        });
        this.#diagnose(connection, "connection.opened");
        this.#sendJSON(connection, { type: "status", status: "idle" });
        return _onConnect?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onClose = (connection: Connection, ...rest: unknown[]) => {
        this.#diagnose(connection, "connection.closed", {
          in_call: this.#cm.isInCall(connection.id)
        });
        this.#requestActiveTurnAbort(
          connection,
          "turn.abort_requested",
          "connection_closed"
        );
        this.#abortInputTurn(connection, "connection_closed");
        this.#activeTurnDiagnostics.delete(connection.id);
        this.#startupTokens.delete(connection.id);
        this.#callTokens.delete(connection.id);
        this.#releaseKeepAlive(connection.id);
        this.#cm.cleanup(connection.id);
        return _onClose?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onMessage = (
        connection: Connection,
        message: WSMessage
      ) => {
        if (message instanceof ArrayBuffer) {
          this.#cm.bufferAudio(connection.id, message);
          return;
        }

        if (typeof message !== "string") {
          return _onMessage?.(connection, message);
        }

        let parsed: { type: string };
        try {
          parsed = JSON.parse(message);
        } catch {
          return _onMessage?.(connection, message);
        }

        if (VoiceAgentMixin.#VOICE_MESSAGES.has(parsed.type)) {
          switch (parsed.type) {
            case "hello":
              break;
            case "start_call":
              runBackground("start_call", () =>
                this.#handleStartCall(
                  connection,
                  (parsed as { preferred_format?: string }).preferred_format
                )
              );
              break;
            case "end_call":
              runBackground("end_call", () => this.#handleEndCall(connection));
              break;
            case "start_of_speech":
            case "end_of_speech":
              break;
            case "interrupt":
              runBackground("interrupt", () =>
                this.#handleInterrupt(connection)
              );
              break;
            case "text_message": {
              const text = (parsed as unknown as { text?: string }).text;
              if (typeof text === "string") {
                runBackground("text_message", () =>
                  this.#handleTextMessage(connection, text)
                );
              }
              break;
            }
          }
          return;
        }

        return _onMessage?.(connection, message);
      };
    }

    // --- User-overridable hooks ---

    onTurn(
      _transcript: string,
      _context: VoiceTurnContext
    ): Promise<TextSource> {
      throw new Error(
        "VoiceAgent subclass must implement onTurn(). Return a string, AI SDK stream, AsyncIterable<string>, or ReadableStream."
      );
    }

    /**
     * Override to create a transcriber dynamically per connection.
     * Useful for runtime model switching (e.g. Flux vs Nova 3 dropdown).
     * Return null to fall back to the `transcriber` property.
     */
    createTranscriber(_connection: Connection): Transcriber | null {
      return null;
    }

    beforeCallStart(_connection: Connection): boolean | Promise<boolean> {
      return true;
    }

    onCallStart(_connection: Connection): void | Promise<void> {}
    onCallEnd(_connection: Connection): void | Promise<void> {}
    onInterrupt(_connection: Connection): void | Promise<void> {}

    afterTranscribe(
      transcript: string,
      _connection: Connection
    ): string | null | Promise<string | null> {
      return transcript;
    }

    beforeSynthesize(
      text: string,
      _connection: Connection
    ): string | null | Promise<string | null> {
      return text;
    }

    afterSynthesize(
      audio: ArrayBuffer | null,
      _text: string,
      _connection: Connection
    ): ArrayBuffer | null | Promise<ArrayBuffer | null> {
      return audio;
    }

    // --- Conversation persistence ---

    saveMessage(role: "user" | "assistant", text: string) {
      this.#ensureSchema();
      this.sql`
        INSERT INTO cf_voice_messages (role, text, timestamp)
        VALUES (${role}, ${text}, ${Date.now()})
      `;

      const maxMessages = opt("maxMessageCount", DEFAULT_MAX_MESSAGE_COUNT);
      this.sql`
        DELETE FROM cf_voice_messages
        WHERE id NOT IN (
          SELECT id FROM cf_voice_messages
          ORDER BY id DESC LIMIT ${maxMessages}
        )
      `;
    }

    getConversationHistory(
      limit?: number
    ): Array<{ role: VoiceRole; content: string }> {
      this.#ensureSchema();
      const historyLimit = limit ?? opt("historyLimit", DEFAULT_HISTORY_LIMIT);
      const rows = this.sql<{ role: VoiceRole; text: string }>`
        SELECT role, text FROM cf_voice_messages
        ORDER BY id DESC LIMIT ${historyLimit}
      `;
      return rows.reverse().map((row) => ({
        role: row.role,
        content: row.text
      }));
    }

    // --- Convenience methods ---

    forceEndCall(connection: Connection): void {
      if (!this.#cm.isInCall(connection.id)) return;
      this.#handleEndCall(connection);
    }

    async speak(connection: Connection, text: string): Promise<void> {
      const signal = this.#cm.createPipelineAbort(connection.id);
      try {
        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, { type: "transcript_end", text });

        const audio = await this.#synthesizeWithHooks(text, connection, signal);
        if (audio && !signal.aborted) {
          this.#sendJSON(connection, { type: "status", status: "speaking" });
          this.#diagnose(connection, "audio.first_sent", {
            bytes: audio.byteLength
          });
          connection.send(audio);
          this.#diagnose(connection, "audio.completed", {
            bytes: audio.byteLength
          });
        }

        if (!signal.aborted) {
          this.#cm.updateAgentContext(connection.id, text);
          this.saveMessage("assistant", text);
          this.#sendJSON(connection, { type: "status", status: "listening" });
        }
      } finally {
        this.#cm.clearPipelineAbort(connection.id, signal);
      }
    }

    async speakAll(text: string): Promise<void> {
      this.saveMessage("assistant", text);

      const connections = [...this.getConnections()];
      if (connections.length === 0) return;

      for (const connection of connections) {
        const signal = this.#cm.createPipelineAbort(connection.id);
        try {
          this.#sendJSON(connection, {
            type: "transcript_start",
            role: "assistant"
          });
          this.#sendJSON(connection, { type: "transcript_end", text });

          const audio = await this.#synthesizeWithHooks(
            text,
            connection,
            signal
          );
          if (audio && !signal.aborted) {
            this.#sendJSON(connection, {
              type: "status",
              status: "speaking"
            });
            this.#diagnose(connection, "audio.first_sent", {
              bytes: audio.byteLength
            });
            connection.send(audio);
            this.#diagnose(connection, "audio.completed", {
              bytes: audio.byteLength
            });
          }

          if (!signal.aborted) {
            this.#cm.updateAgentContext(connection.id, text);
            this.#sendJSON(connection, {
              type: "status",
              status: "listening"
            });
          }
        } finally {
          this.#cm.clearPipelineAbort(connection.id, signal);
        }
      }
    }

    #requireTTS(): TTSProvider & Partial<StreamingTTSProvider> {
      if (!this.tts) {
        throw new Error(
          "No TTS provider configured. Set 'tts' on your VoiceAgent subclass."
        );
      }
      return this.tts;
    }

    async #synthesizeWithHooks(
      text: string,
      connection: Connection,
      signal?: AbortSignal,
      turn?: TurnDiagnostics
    ): Promise<ArrayBuffer | null> {
      const sentence = turn?.beginTtsSentence();
      let sentenceOutcome: "completed" | "skipped" | "failed" = "completed";
      try {
        let textToSpeak: string | null;
        try {
          textToSpeak = await this.beforeSynthesize(text, connection);
        } catch (error) {
          const voiceError = toVoiceError(error, "TTS preparation failed");
          this.#emitTurnDiagnostic(connection, turn, "tts.failed", {
            stage: "before_synthesize",
            error: voiceError
          });
          throw voiceError;
        }

        if (!textToSpeak) {
          sentenceOutcome = "skipped";
          this.#emitTurnDiagnostic(connection, turn, "tts.skipped", {
            reason: "before_synthesize"
          });
          return null;
        }

        let tts: TTSProvider & Partial<StreamingTTSProvider>;
        try {
          tts = this.#requireTTS();
        } catch (error) {
          const voiceError = toVoiceError(error, "TTS is not configured");
          this.#emitTurnDiagnostic(connection, turn, "tts.failed", {
            stage: "configuration",
            error: voiceError
          });
          throw voiceError;
        }

        const startedAt = Date.now();
        this.#emitTurnDiagnostic(connection, turn, "tts.started", {
          characters: textToSpeak.length
        });
        sentence?.providerStarted();
        try {
          const rawAudio = await tts.synthesize(textToSpeak, signal);
          const audio = await this.afterSynthesize(
            rawAudio,
            textToSpeak,
            connection
          );
          this.#emitTurnDiagnostic(connection, turn, "tts.completed", {
            duration_ms: Date.now() - startedAt,
            outcome: audio ? "audio" : "no_audio",
            bytes: audio?.byteLength ?? 0
          });
          return audio;
        } catch (error) {
          const voiceError = toVoiceError(error, "TTS failed");
          this.#emitTurnDiagnostic(connection, turn, "tts.failed", {
            duration_ms: Date.now() - startedAt,
            error: voiceError
          });
          throw voiceError;
        }
      } catch (error) {
        sentenceOutcome = "failed";
        throw error;
      } finally {
        sentence?.settle(sentenceOutcome);
      }
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection, _preferredFormat?: string) {
      if (this.#cm.isInCall(connection.id)) {
        this.#diagnose(connection, "call.start_ignored", {
          reason: "already_active"
        });
        return;
      }

      this.#diagnose(connection, "call.starting");
      this.#abortInputTurn(connection, "call_restarted");
      const startupToken = Symbol(connection.id);
      this.#startupTokens.set(connection.id, startupToken);
      this.#callTokens.set(connection.id, startupToken);

      // Mark as in-call before any await to prevent duplicate start_call
      // from leaking keepAlive refs during the beforeCallStart window.
      this.#cm.initConnection(connection.id);

      let provider: Transcriber | undefined;

      try {
        const allowed = await this.beforeCallStart(connection);
        if (!this.#isCurrentStartup(connection.id, startupToken)) return;
        if (!allowed) {
          await this.#handleStartupFailure(
            connection,
            startupToken,
            undefined,
            "Voice call was rejected",
            null
          );
          return;
        }

        provider = this.createTranscriber(connection) ?? this.transcriber;
        if (!provider) {
          const message =
            "No transcriber configured. Set 'transcriber' on your VoiceAgent subclass or override createTranscriber().";
          logVoiceError({
            component: "VoiceAgent",
            stage: "configuration",
            message,
            connectionId: connection.id,
            error: new Error(message)
          });
          await this.#handleStartupFailure(
            connection,
            startupToken,
            undefined,
            message,
            null
          );
          return;
        }

        const dispose = await this.keepAlive();
        if (!this.#isCurrentStartup(connection.id, startupToken)) {
          dispose();
          return;
        }
        this.#keepAliveDispose.set(connection.id, dispose);

        const configuredFormat = opt("audioFormat", "mp3") as VoiceAudioFormat;
        const configuredSampleRate = opt("sampleRate", DEFAULT_SAMPLE_RATE);
        this.#sendJSON(connection, {
          type: "audio_config",
          format: configuredFormat,
          sampleRate: configuredSampleRate
        });
      } catch (error) {
        await this.#handleStartupFailure(
          connection,
          startupToken,
          toVoiceError(error, "Voice call failed to start"),
          "Voice call failed to start"
        );
        return;
      }

      if (!provider) return;

      let session: TranscriberSession;
      try {
        this.#diagnose(connection, "stt.starting");
        session = this.#cm.startTranscriberSession(connection.id, provider, {
          onInterim: (text: string) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const turn = this.#getOrCreateInputTurn(connection);
            turn.firstInterim(text.length);
            this.#sendJSON(connection, {
              type: "transcript_interim",
              text
            });
          },
          onSpeechStart: () => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const turn = this.#replaceInputTurn(connection);
            turn.speechStarted();
            this.#handleBargeIn(connection);
          },
          onUtterance: (transcript: string) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const turn = this.#takeInputTurn(connection);
            turn.finalInput(transcript.length);
            this.#sendJSON(connection, {
              type: "transcript_interim",
              text: ""
            });
            this.#runPipeline(connection, transcript, turn);
          },
          onFatalError: (error: Error) => {
            runBackground("transcriber_fatal", () =>
              this.#handleTranscriberFatal(connection, startupToken, error)
            );
          }
        });

        await session.waitUntilReady?.();
      } catch (error) {
        await this.#handleTranscriberStartupFailure(
          connection,
          startupToken,
          toVoiceError(error, "Speech recognition failed to start")
        );
        return;
      }

      if (!this.#isCurrentStartup(connection.id, startupToken)) return;
      this.#startupTokens.delete(connection.id);

      this.#diagnose(connection, "stt.ready");
      this.#sendJSON(connection, { type: "status", status: "listening" });
      this.#diagnose(connection, "call.ready");
      await this.onCallStart(connection);
    }

    #isCurrentStartup(connectionId: string, startupToken: symbol): boolean {
      return (
        this.#startupTokens.get(connectionId) === startupToken &&
        this.#cm.isInCall(connectionId)
      );
    }

    async #handleTranscriberStartupFailure(
      connection: Connection,
      startupToken: symbol,
      error: Error
    ): Promise<void> {
      await this.#handleStartupFailure(
        connection,
        startupToken,
        error,
        "Speech recognition failed to start",
        "transcriber_startup",
        {
          code: "stt_startup_failed",
          stage: "stt",
          retryable: false
        }
      );
    }

    async #handleStartupFailure(
      connection: Connection,
      startupToken: symbol,
      error: Error | undefined,
      clientMessage: string,
      logStage: string | null = "call_startup",
      structuredError?: {
        code: "stt_startup_failed";
        stage: "stt";
        retryable: false;
      }
    ): Promise<void> {
      if (!this.#isCurrentStartup(connection.id, startupToken)) return;

      // The client starts local audio optimistically on start_call. Every
      // terminal startup path must send error + idle so it tears that down.
      if (logStage && error !== undefined) {
        logVoiceError({
          component: "VoiceAgent",
          stage: logStage,
          message: clientMessage,
          connectionId: connection.id,
          error
        });
      }
      this.#startupTokens.delete(connection.id);
      if (this.#callTokens.get(connection.id) === startupToken) {
        this.#callTokens.delete(connection.id);
      }
      this.#diagnose(connection, "call.start_failed", {
        stage: logStage ?? "authorization",
        retryable: structuredError?.retryable ?? false,
        ...(error === undefined ? {} : { error })
      });
      this.#sendJSON(connection, {
        type: "error",
        message: clientMessage,
        ...structuredError
      });
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      this.#diagnose(connection, "cleanup.completed");
      this.#diagnose(connection, "call.ended", {
        reason: "startup_failed"
      });
      this.#sendJSON(connection, { type: "status", status: "idle" });
      await this.onCallEnd(connection);
    }

    async #handleTranscriberFatal(
      connection: Connection,
      callToken: symbol,
      error: Error
    ): Promise<void> {
      if (
        this.#callTokens.get(connection.id) !== callToken ||
        !this.#cm.isInCall(connection.id)
      ) {
        return;
      }

      const isStarting = this.#startupTokens.get(connection.id) === callToken;
      const message = isStarting
        ? "Speech recognition failed to start"
        : "Speech recognition connection was lost";
      logVoiceError({
        component: "VoiceAgent",
        stage: isStarting ? "transcriber_startup" : "transcriber_runtime",
        message,
        connectionId: connection.id,
        error
      });
      this.#startupTokens.delete(connection.id);
      this.#callTokens.delete(connection.id);
      this.#abortInputTurn(connection, "stt_fatal");
      this.#diagnose(connection, "stt.fatal", {
        stage: isStarting ? "startup" : "runtime",
        retryable: !isStarting,
        error
      });
      this.#sendJSON(connection, {
        type: "error",
        message,
        code: isStarting ? "stt_startup_failed" : "stt_connection_lost",
        stage: "stt",
        retryable: !isStarting
      });
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      this.#diagnose(connection, "cleanup.completed");
      this.#diagnose(connection, "call.ended", { reason: "stt_fatal" });
      this.#sendJSON(connection, { type: "status", status: "idle" });
      await this.onCallEnd(connection);
    }

    #releaseKeepAlive(connectionId: string) {
      const dispose = this.#keepAliveDispose.get(connectionId);
      if (dispose) {
        dispose();
        this.#keepAliveDispose.delete(connectionId);
      }
    }

    #handleEndCall(connection: Connection): void | Promise<void> {
      this.#diagnose(connection, "call.ended", { reason: "requested" });
      this.#requestActiveTurnAbort(
        connection,
        "turn.abort_requested",
        "call_ended"
      );
      this.#startupTokens.delete(connection.id);
      this.#callTokens.delete(connection.id);
      this.#abortInputTurn(connection, "call_ended");
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      this.#diagnose(connection, "cleanup.completed");
      this.#sendJSON(connection, { type: "status", status: "idle" });
      return this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection): void | Promise<void> {
      this.#abortInputTurn(connection, "client_interrupt");
      this.#requestActiveTurnAbort(
        connection,
        "turn.interrupt_requested",
        "client_interrupt"
      );
      this.#cm.abortPipeline(connection.id);
      this.#cm.clearAudioBuffer(connection.id);
      this.#sendJSON(connection, { type: "status", status: "listening" });
      return this.onInterrupt(connection);
    }

    #handleBargeIn(connection: Connection) {
      this.#requestActiveTurnAbort(
        connection,
        "turn.abort_requested",
        "barge_in"
      );
      if (!this.#cm.abortPipeline(connection.id)) return;
      this.#sendJSON(connection, { type: "playback_interrupt" });
      this.#sendJSON(connection, { type: "status", status: "listening" });
      this.onInterrupt(connection);
    }

    #createTurn(
      connection: Connection,
      source: "speech" | "text"
    ): TurnDiagnostics {
      const turn = diagnostics.turn(
        connection,
        `turn_${(++this.#turnSequence).toString(36)}`,
        source
      );
      if (source === "text") turn.markTextInput();
      turn.emit("turn.started", { source });
      return turn;
    }

    #replaceInputTurn(connection: Connection): TurnDiagnostics {
      this.#abortInputTurn(connection, "replaced");
      const turn = this.#createTurn(connection, "speech");
      this.#inputTurns.set(connection.id, turn);
      return turn;
    }

    #getOrCreateInputTurn(connection: Connection): TurnDiagnostics {
      const current = this.#inputTurns.get(connection.id);
      if (current) return current;
      const turn = this.#createTurn(connection, "speech");
      this.#inputTurns.set(connection.id, turn);
      return turn;
    }

    #takeInputTurn(connection: Connection): TurnDiagnostics {
      const turn = this.#getOrCreateInputTurn(connection);
      this.#inputTurns.delete(connection.id);
      return turn;
    }

    #abortInputTurn(connection: Connection, reason: string): void {
      const turn = this.#inputTurns.get(connection.id);
      if (!turn) return;
      this.#inputTurns.delete(connection.id);
      turn.emit("turn.aborted", { reason });
      turn.finish("aborted");
    }

    #beginTurnDiagnostics(
      connection: Connection,
      source: "speech" | "text",
      turn = this.#createTurn(connection, source)
    ): ActiveTurnDiagnostics {
      const previous = this.#activeTurnDiagnostics.get(connection.id);
      if (previous) {
        previous.turn.emit("turn.abort_requested", { reason: "replaced" });
        previous.model?.abort();
      }

      const signal = this.#cm.createPipelineAbort(connection.id);
      const active: ActiveTurnDiagnostics = { signal, turn };
      this.#activeTurnDiagnostics.set(connection.id, active);
      return active;
    }

    #requestActiveTurnAbort(
      connection: Connection,
      event: "turn.abort_requested" | "turn.interrupt_requested",
      reason: string
    ): void {
      const active = this.#activeTurnDiagnostics.get(connection.id);
      if (!active) return;
      active.turn.emit(event, { reason });
      active.model?.abort();
    }

    #clearActiveTurn(
      connectionId: string,
      active: ActiveTurnDiagnostics
    ): void {
      if (this.#activeTurnDiagnostics.get(connectionId) === active) {
        this.#activeTurnDiagnostics.delete(connectionId);
      }
    }

    #emitTurnDiagnostic(
      connection: Connection,
      turn: TurnDiagnostics | undefined,
      event: string,
      data?: DiagnosticData
    ): void {
      if (turn) {
        turn.emit(event, data);
      } else {
        this.#diagnose(connection, event, data);
      }
    }

    // --- Internal: text message handling ---

    async #handleTextMessage(connection: Connection, text: string) {
      if (!text || text.trim().length === 0) return;

      const userText = text.trim();
      const pipelineStart = Date.now();
      const active = this.#beginTurnDiagnostics(connection, "text");
      const { signal, turn } = active;
      let turnOutcome: VoiceTurnOutcome = "completed";

      this.#sendJSON(connection, { type: "status", status: "thinking" });

      const priorMessages = this.getConversationHistory();
      this.saveMessage("user", userText);
      this.#sendJSON(connection, {
        type: "transcript",
        role: "user",
        text: userText
      });

      try {
        const context: VoiceTurnContext = {
          connection,
          messages: priorMessages,
          signal
        };

        const model = turn.startModel();
        active.model = model;
        const turnResult = await this.onTurn(userText, context);

        if (signal.aborted) return;

        const isInCall = this.#cm.isInCall(connection.id);

        if (isInCall) {
          const { text: fullText, finishReason } = await this.#streamResponse(
            connection,
            turnResult,
            pipelineStart,
            signal,
            turn,
            model
          );

          if (signal.aborted) return;

          const hasOutput = fullText.trim().length > 0;
          turnOutcome = stableTurnOutcome(finishReason, hasOutput);
          if (turnOutcome === "completed" && turn.hasTtsFailures) {
            turnOutcome = "tts_error";
          }
          if (hasOutput) {
            this.#cm.updateAgentContext(connection.id, fullText);
            this.saveMessage("assistant", fullText);
          }
          const completionOutcome = createCompletionOutcome(
            finishReason,
            hasOutput
          );
          if (completionOutcome) {
            this.#sendJSON(connection, {
              type: "completion_outcome",
              ...completionOutcome
            });
          }
          if (!hasOutput) {
            this.#sendJSON(connection, {
              type: "error",
              message: "No response generated"
            });
          }
          this.#sendJSON(connection, { type: "status", status: "listening" });
        } else {
          let fullText = "";
          let pendingText = "";
          let transcriptStarted = false;

          const sendAssistantDelta = (token: string) => {
            if (!transcriptStarted) {
              pendingText += token;
              if (pendingText.trim().length === 0) return;

              this.#sendJSON(connection, {
                type: "transcript_start",
                role: "assistant"
              });
              transcriptStarted = true;
              token = pendingText;
              pendingText = "";
            }

            this.#sendJSON(connection, {
              type: "transcript_delta",
              text: token
            });
          };

          let finishReason: VoiceModelFinishReason | undefined;
          for await (const event of iterateTextEvents(turnResult)) {
            if (signal.aborted) break;
            model.observe(event);
            if (event.type === "finish") {
              finishReason = event.finishReason;
            } else if (event.type === "error") {
              if (transcriptStarted) {
                this.#sendJSON(connection, {
                  type: "transcript_end",
                  text: fullText
                });
              }
              throw new ModelStreamError(
                event.error,
                fullText.trim().length > 0
              );
            } else if (event.type === "text") {
              fullText += event.text;
              sendAssistantDelta(event.text);
            }
          }

          const hasOutput = fullText.trim().length > 0;
          model.complete(hasOutput ? "output" : "no_output", finishReason);
          turnOutcome = stableTurnOutcome(finishReason, hasOutput);
          if (hasOutput) {
            if (transcriptStarted) {
              this.#sendJSON(connection, {
                type: "transcript_end",
                text: fullText
              });
            }
            this.saveMessage("assistant", fullText);
          }
          const completionOutcome = createCompletionOutcome(
            finishReason,
            hasOutput
          );
          if (completionOutcome) {
            this.#sendJSON(connection, {
              type: "completion_outcome",
              ...completionOutcome
            });
          }
          if (!hasOutput) {
            this.#sendJSON(connection, {
              type: "error",
              message: "No response generated"
            });
          }
          this.#sendJSON(connection, { type: "status", status: "idle" });
        }
      } catch (error) {
        if (signal.aborted) return;
        turnOutcome =
          error instanceof ModelStreamError
            ? "model_error"
            : turn.hasTtsFailures
              ? "tts_error"
              : "error";
        const pipelineError =
          error instanceof ModelStreamError
            ? error.streamError
            : toVoiceError(error, "Text turn failed");
        active.model?.fail(pipelineError);
        turn.emit("turn.error", {
          stage: error instanceof ModelStreamError ? "model" : "pipeline",
          error: pipelineError
        });
        if (error instanceof ModelStreamError) {
          this.#sendJSON(connection, {
            type: "completion_outcome",
            code: "model_error",
            stage: "llm",
            partialOutput: error.partialOutput
          });
        }
        logVoiceError({
          component: "VoiceAgent",
          stage: "text_pipeline",
          message: "Text pipeline failed",
          connectionId: connection.id,
          error: pipelineError
        });
        this.#sendJSON(connection, {
          type: "error",
          message: voiceErrorMessage(pipelineError, "Text pipeline failed")
        });
        this.#sendJSON(connection, {
          type: "status",
          status: this.#cm.isInCall(connection.id) ? "listening" : "idle"
        });
      } finally {
        if (signal.aborted) {
          turnOutcome = "aborted";
          active.model?.abort();
          turn.emit("turn.aborted");
        }
        turn.finish(turnOutcome);
        this.#cm.clearPipelineAbort(connection.id, signal);
        this.#clearActiveTurn(connection.id, active);
      }
    }

    // --- Internal: voice pipeline ---

    async #runPipeline(
      connection: Connection,
      transcript: string,
      turn: TurnDiagnostics
    ) {
      const pipelineStart = Date.now();
      const active = this.#beginTurnDiagnostics(connection, "speech", turn);
      const { signal } = active;
      let turnOutcome: VoiceTurnOutcome = "completed";

      try {
        const afterTranscribeStart = Date.now();
        const userText = await this.afterTranscribe(transcript, connection);
        turn.recordAfterTranscribe(
          Date.now() - afterTranscribeStart,
          userText ? "accepted" : "skipped",
          userText?.length ?? 0
        );
        if (signal.aborted) return;
        if (!userText) {
          turnOutcome = "skipped";
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const priorMessages = this.getConversationHistory();
        this.saveMessage("user", userText);
        this.#sendJSON(connection, {
          type: "transcript",
          role: "user",
          text: userText
        });

        this.#sendJSON(connection, { type: "status", status: "thinking" });

        const context: VoiceTurnContext = {
          connection,
          messages: priorMessages,
          signal
        };

        const model = turn.startModel();
        active.model = model;
        const turnResult = await this.onTurn(userText, context);

        if (signal.aborted) return;

        const {
          text: fullText,
          llmMs,
          ttsMs,
          firstAudioMs,
          finishReason
        } = await this.#streamResponse(
          connection,
          turnResult,
          pipelineStart,
          signal,
          turn,
          model
        );

        if (signal.aborted) return;

        const hasOutput = fullText.trim().length > 0;
        turnOutcome = stableTurnOutcome(finishReason, hasOutput);
        if (turnOutcome === "completed" && turn.hasTtsFailures) {
          turnOutcome = "tts_error";
        }

        if (!hasOutput) {
          const completionOutcome = createCompletionOutcome(
            finishReason,
            false
          );
          this.#sendJSON(connection, {
            type: "completion_outcome",
            ...completionOutcome
          });
          this.#sendJSON(connection, {
            type: "error",
            message: "No response generated"
          });
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const completionOutcome = createCompletionOutcome(finishReason, true);
        if (completionOutcome) {
          this.#sendJSON(connection, {
            type: "completion_outcome",
            ...completionOutcome
          });
        }

        const totalMs = Date.now() - pipelineStart;

        this.#sendJSON(connection, {
          type: "metrics",
          llm_ms: llmMs,
          tts_ms: ttsMs,
          first_audio_ms: firstAudioMs,
          total_ms: totalMs
        });

        // Feed the agent's spoken reply back to the transcriber as context for
        // the user's next turn (no-op for providers without context carryover).
        this.#cm.updateAgentContext(connection.id, fullText);
        this.saveMessage("assistant", fullText);
        this.#sendJSON(connection, { type: "status", status: "listening" });
      } catch (error) {
        if (signal.aborted) return;
        turnOutcome =
          error instanceof ModelStreamError
            ? "model_error"
            : turn.hasTtsFailures
              ? "tts_error"
              : "error";
        const pipelineError =
          error instanceof ModelStreamError
            ? error.streamError
            : toVoiceError(error, "Voice turn failed");
        active.model?.fail(pipelineError);
        turn.emit("turn.error", {
          stage: error instanceof ModelStreamError ? "model" : "pipeline",
          error: pipelineError
        });
        if (error instanceof ModelStreamError) {
          this.#sendJSON(connection, {
            type: "completion_outcome",
            code: "model_error",
            stage: "llm",
            partialOutput: error.partialOutput
          });
        }
        logVoiceError({
          component: "VoiceAgent",
          stage: "pipeline",
          message: "Voice pipeline failed",
          connectionId: connection.id,
          error: pipelineError
        });
        this.#sendJSON(connection, {
          type: "error",
          message: voiceErrorMessage(pipelineError, "Voice pipeline failed")
        });
        this.#sendJSON(connection, { type: "status", status: "listening" });
      } finally {
        if (signal.aborted) {
          turnOutcome = "aborted";
          active.model?.abort();
          turn.emit("turn.aborted");
        }
        turn.finish(turnOutcome);
        this.#cm.clearPipelineAbort(connection.id, signal);
        this.#clearActiveTurn(connection.id, active);
      }
    }

    // --- Internal: streaming TTS pipeline ---

    async #streamResponse(
      connection: Connection,
      response: TextSource,
      pipelineStart: number,
      signal: AbortSignal,
      turn: TurnDiagnostics,
      model: ModelDiagnosticTracker
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstAudioMs: number;
      finishReason?: VoiceModelFinishReason;
    }> {
      if (typeof response === "string") {
        const llmMs = model.elapsedMs();

        if (response.trim().length === 0) {
          model.complete("no_output");
          return { text: response, llmMs, ttsMs: 0, firstAudioMs: 0 };
        }

        model.observe({ type: "text", text: response });
        model.complete("output");
        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, {
          type: "transcript_end",
          text: response
        });

        const ttsStart = Date.now();
        let audio: ArrayBuffer | null;
        try {
          audio = await this.#synthesizeWithHooks(
            response,
            connection,
            undefined,
            turn
          );
        } finally {
          turn.finishTts();
        }
        const ttsMs = Date.now() - ttsStart;

        let firstAudioMs = 0;
        if (audio && !signal.aborted) {
          this.#sendJSON(connection, { type: "status", status: "speaking" });
          firstAudioMs = Date.now() - pipelineStart;
          turn.emit("audio.first_sent", {
            bytes: audio.byteLength,
            elapsed_ms: firstAudioMs
          });
          turn.audioSent();
          connection.send(audio);
          turn.emit("audio.completed", {
            bytes: audio.byteLength
          });
        }

        return { text: response, llmMs, ttsMs, firstAudioMs };
      }

      try {
        return await this.#streamingTTSPipeline(
          connection,
          iterateTextEvents(response),
          pipelineStart,
          signal,
          turn,
          model
        );
      } finally {
        turn.finishTts();
      }
    }

    async #streamingTTSPipeline(
      connection: Connection,
      tokenStream: AsyncIterable<TextStreamEvent>,
      pipelineStart: number,
      signal: AbortSignal,
      turn: TurnDiagnostics,
      model: ModelDiagnosticTracker
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstAudioMs: number;
      finishReason?: VoiceModelFinishReason;
    }> {
      const chunker = new SentenceChunker();
      const ttsQueue: AsyncIterable<ArrayBuffer>[] = [];
      let fullText = "";
      let pendingTranscriptText = "";
      let transcriptStarted = false;
      let firstAudioSentAt: number | null = null;
      let firstTtsStartedAt: number | null = null;
      let cumulativeTtsMs = 0;
      let totalAudioBytes = 0;
      let skippedSentences = 0;
      let ttsFailures = 0;
      let finishReason: VoiceModelFinishReason | undefined;

      let streamComplete = false;
      let drainNotify: (() => void) | null = null;
      let drainPending = false;
      let drainedCount = 0;
      const drainWaiters = new Map<number, (() => void)[]>();

      const notifyDrain = () => {
        if (drainNotify) {
          const resolve = drainNotify;
          drainNotify = null;
          resolve();
        } else {
          drainPending = true;
        }
      };

      const notifyDrained = () => {
        for (const [target, waiters] of drainWaiters) {
          if (drainedCount < target) continue;
          drainWaiters.delete(target);
          for (const resolve of waiters) resolve();
        }
      };

      const waitForDrained = (target: number): Promise<void> => {
        if (drainedCount >= target) return Promise.resolve();

        return new Promise<void>((resolve) => {
          const waiters = drainWaiters.get(target) ?? [];
          waiters.push(resolve);
          drainWaiters.set(target, waiters);
        });
      };

      const tts = this.#requireTTS();
      const hasStreamingTTS = typeof tts.synthesizeStream === "function";

      const drainPromise = (async () => {
        let i = 0;
        while (true) {
          while (i >= ttsQueue.length) {
            if (streamComplete && i >= ttsQueue.length) return;
            if (drainPending) {
              drainPending = false;
              continue;
            }
            await new Promise<void>((r) => {
              drainNotify = r;
            });
            if (streamComplete && i >= ttsQueue.length) return;
          }

          if (signal.aborted) return;

          try {
            for await (const chunk of ttsQueue[i]) {
              if (signal.aborted) return;
              if (firstAudioSentAt === null) {
                this.#sendJSON(connection, {
                  type: "status",
                  status: "speaking"
                });
                firstAudioSentAt = Date.now();
                turn.emit("audio.first_sent", {
                  bytes: chunk.byteLength,
                  elapsed_ms: firstAudioSentAt - pipelineStart
                });
              }
              totalAudioBytes += chunk.byteLength;
              turn.audioSent();
              connection.send(chunk);
            }
          } catch (error) {
            if (signal.aborted) return;
            const voiceError = toVoiceError(error, "TTS sentence failed");
            ttsFailures++;
            turn.emit("tts.failed", { error: voiceError });
            logVoiceError({
              component: "VoiceAgent",
              stage: "tts",
              message: "TTS failed for a sentence",
              connectionId: connection.id,
              error: voiceError
            });
            this.#sendJSON(connection, {
              type: "error",
              message: voiceErrorMessage(
                voiceError,
                "TTS failed for a sentence"
              )
            });
          }
          i++;
          drainedCount = i;
          notifyDrained();
        }
      })();

      const makeSentenceTTS = (
        sentence: string
      ): AsyncIterable<ArrayBuffer> => {
        const self = this;
        async function* generate() {
          const attempt = turn.beginTtsSentence();
          let sentenceOutcome: "completed" | "skipped" | "failed" = "completed";
          try {
            const text = await self.beforeSynthesize(sentence, connection);
            if (!text) {
              sentenceOutcome = "skipped";
              skippedSentences++;
              return;
            }

            if (firstTtsStartedAt === null) {
              firstTtsStartedAt = Date.now();
              turn.emit("tts.started", {
                mode: hasStreamingTTS ? "streaming" : "buffered",
                characters: text.length
              });
            }
            attempt.providerStarted();

            if (hasStreamingTTS) {
              for await (const chunk of tts.synthesizeStream!(text, signal)) {
                const processed = await self.afterSynthesize(
                  chunk,
                  text,
                  connection
                );
                if (processed) yield processed;
              }
            } else {
              const rawAudio = await tts.synthesize(text, signal);
              const processed = await self.afterSynthesize(
                rawAudio,
                text,
                connection
              );
              if (processed) yield processed;
            }
          } catch (error) {
            sentenceOutcome = "failed";
            throw error;
          } finally {
            cumulativeTtsMs += attempt.settle(sentenceOutcome);
          }
        }

        return eagerAsyncIterable(generate());
      };

      const enqueueSentence = (sentence: string) => {
        ttsQueue.push(makeSentenceTTS(sentence));
        notifyDrain();
      };

      const sendAssistantDelta = (token: string) => {
        if (!transcriptStarted) {
          pendingTranscriptText += token;
          if (pendingTranscriptText.trim().length === 0) return;

          this.#sendJSON(connection, {
            type: "transcript_start",
            role: "assistant"
          });
          transcriptStarted = true;
          token = pendingTranscriptText;
          pendingTranscriptText = "";
        }

        this.#sendJSON(connection, { type: "transcript_delta", text: token });
      };

      for await (const event of tokenStream) {
        if (signal.aborted) break;
        model.observe(event);

        if (event.type === "boundary") {
          for (const sentence of chunker.flush()) {
            enqueueSentence(sentence);
          }
          await waitForDrained(ttsQueue.length);
          continue;
        }

        if (event.type === "finish") {
          finishReason = event.finishReason;
          continue;
        }

        if (event.type === "error") {
          for (const sentence of chunker.flush()) {
            enqueueSentence(sentence);
          }
          await waitForDrained(ttsQueue.length);
          if (transcriptStarted) {
            this.#sendJSON(connection, {
              type: "transcript_end",
              text: fullText
            });
          }
          streamComplete = true;
          notifyDrain();
          await drainPromise;
          throw new ModelStreamError(event.error, fullText.trim().length > 0);
        }

        if (event.type !== "text") continue;
        const token = event.text;

        fullText += token;
        sendAssistantDelta(token);

        const sentences = chunker.add(token);
        for (const sentence of sentences) {
          enqueueSentence(sentence);
        }
      }

      const llmMs = model.elapsedMs();
      model.complete(
        fullText.trim().length > 0 ? "output" : "no_output",
        finishReason
      );

      const remaining = chunker.flush();
      for (const sentence of remaining) {
        enqueueSentence(sentence);
      }

      streamComplete = true;
      notifyDrain();
      if (transcriptStarted) {
        this.#sendJSON(connection, { type: "transcript_end", text: fullText });
      }

      await drainPromise;

      if (firstTtsStartedAt === null) {
        turn.emit("tts.skipped", {
          reason:
            fullText.trim().length === 0
              ? "no_output"
              : ttsFailures > 0
                ? "preparation_failed"
                : "before_synthesize",
          sentences: skippedSentences,
          failures: ttsFailures
        });
      } else {
        turn.emit("tts.completed", {
          duration_ms: Date.now() - firstTtsStartedAt,
          outcome:
            totalAudioBytes > 0
              ? ttsFailures > 0
                ? "partial"
                : "audio"
              : ttsFailures > 0
                ? "failed"
                : "no_audio",
          bytes: totalAudioBytes,
          failures: ttsFailures,
          skipped_sentences: skippedSentences
        });
      }
      if (totalAudioBytes > 0) {
        turn.emit("audio.completed", {
          bytes: totalAudioBytes
        });
      }

      const firstAudioMs = firstAudioSentAt
        ? firstAudioSentAt - pipelineStart
        : 0;

      return {
        text: fullText,
        llmMs,
        ttsMs: cumulativeTtsMs,
        firstAudioMs,
        ...(finishReason === undefined ? {} : { finishReason })
      };
    }

    // --- Internal: protocol helpers ---

    #diagnose(
      connection: Connection,
      event: string,
      data?: DiagnosticData
    ): void {
      diagnostics.emit(connection, event, data);
    }

    #sendJSON(connection: Connection, data: unknown) {
      const parsed = data as Record<string, unknown>;
      sendVoiceJSON(
        connection,
        data,
        "VoiceAgent",
        parsed.type === "transcript_delta"
      );
    }
  }

  return VoiceAgentMixin as unknown as VoiceAgentMixinReturn<TBase>;
}

// --- Eager async iterable ---

function eagerAsyncIterable<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  const buffer: T[] = [];
  let finished = false;
  let error: unknown = null;
  let waitResolve: (() => void) | null = null;

  const notify = () => {
    if (waitResolve) {
      const resolve = waitResolve;
      waitResolve = null;
      resolve();
    }
  };

  (async () => {
    try {
      for await (const item of source) {
        buffer.push(item);
        notify();
      }
    } catch (err) {
      error = err;
    } finally {
      finished = true;
      notify();
    }
  })();

  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          while (index >= buffer.length && !finished) {
            await new Promise<void>((r) => {
              waitResolve = r;
            });
          }
          if (error) {
            throw error;
          }
          if (index >= buffer.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: buffer[index++] };
        }
      };
    }
  };
}
