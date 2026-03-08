/**
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * !! WARNING: EXPERIMENTAL — DO NOT USE IN PRODUCTION                  !!
 * !!                                                                   !!
 * !! This API is under active development and WILL break between       !!
 * !! releases. Method names, types, behavior, and the mixin signature  !!
 * !! are all subject to change without notice.                         !!
 * !!                                                                   !!
 * !! If you use this, pin your agents version and expect to rewrite    !!
 * !! your code when upgrading.                                         !!
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * Experimental voice pipeline mixin for the Agents SDK.
 *
 * Usage:
 *   import { Agent } from "agents";
 *   import { withVoice } from "agents/experimental/voice";
 *
 *   const VoiceAgent = withVoice(Agent);
 *
 *   class MyAgent extends VoiceAgent<Env> {
 *     async onTurn(transcript: string, context: VoiceTurnContext) {
 *       const result = streamText({ ... });
 *       return result.textStream;
 *     }
 *   }
 *
 * This mixin adds the full voice pipeline: audio buffering, VAD, STT,
 * streaming TTS, interruption handling, conversation persistence, and
 * the WebSocket voice protocol.
 *
 * @experimental This API is not yet stable and may change.
 */

import type { Agent, Connection, WSMessage } from "agents";
import { SentenceChunker } from "./sentence-chunker";
import { iterateText, type TextSource } from "./text-stream";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceClientMessage,
  VoiceServerMessage,
  VoicePipelineMetrics,
  STTProvider,
  TTSProvider,
  StreamingTTSProvider,
  VADProvider,
  StreamingSTTProvider
} from "./types";
import {
  AudioConnectionManager,
  sendVoiceJSON,
  DEFAULT_VAD_THRESHOLD,
  DEFAULT_MIN_AUDIO_BYTES,
  DEFAULT_VAD_PUSHBACK_SECONDS,
  DEFAULT_VAD_RETRY_MS
} from "./audio-pipeline";
import type { VoiceInputAgentOptions } from "./voice-input";

// Re-export SentenceChunker for direct use
export { SentenceChunker } from "./sentence-chunker";

// Re-export protocol version constant
export { VOICE_PROTOCOL_VERSION } from "./types";

// Re-export shared types so existing imports from "agents/experimental/voice" still work
export type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceTransport,
  VoiceClientMessage,
  VoiceServerMessage,
  VoicePipelineMetrics,
  TranscriptMessage,
  STTProvider,
  TTSProvider,
  StreamingTTSProvider,
  VADProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions
} from "./types";

// Re-export voice input mixin (STT-only, no TTS/LLM)
export { withVoiceInput } from "./voice-input";
export type { VoiceInputAgentOptions } from "./voice-input";

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

// Re-export Workers AI providers and audio utility
export {
  WorkersAISTT,
  WorkersAITTS,
  WorkersAIVAD,
  WorkersAIFluxSTT,
  pcmToWav
} from "./workers-ai-providers";
export type {
  WorkersAISTTOptions,
  WorkersAITTSOptions,
  WorkersAIVADOptions,
  WorkersAIFluxSTTOptions
} from "./workers-ai-providers";

// --- Public types ---

/** Result from a VAD (Voice Activity Detection) provider. */
export interface VADResult {
  isComplete: boolean;
  probability: number;
}

/** Context passed to the `onTurn()` hook. */
export interface VoiceTurnContext {
  /**
   * The WebSocket connection that sent the audio.
   * Useful for sending custom JSON messages (e.g. tool progress).
   * WARNING: sending raw binary on this connection will interleave with
   * the TTS audio stream. Use `connection.send(JSON.stringify(...))` only.
   */
  connection: Connection;
  /** Conversation history from SQLite (chronological order). */
  messages: Array<{ role: VoiceRole; content: string }>;
  /** AbortSignal — aborted if user interrupts or disconnects. */
  signal: AbortSignal;
}

/** Configuration options for the voice mixin. Passed to `withVoice()`. */
export interface VoiceAgentOptions extends VoiceInputAgentOptions {
  /** Max conversation history messages loaded for context. @default 20 */
  historyLimit?: number;
  /** Audio format used for binary audio payloads sent to the client. @default "mp3" */
  audioFormat?: VoiceAudioFormat;
  /** Max conversation messages to keep in SQLite. Oldest are pruned. @default 1000 */
  maxMessageCount?: number;
}

// --- Default option values (voice-specific, not in audio-pipeline) ---

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_COUNT = 1000;

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<
  Pick<
    Agent<Cloudflare.Env>,
    | "sql"
    | "getConnections"
    | "_unsafe_getConnectionFlag"
    | "_unsafe_setConnectionFlag"
  >
>;

/**
 * Voice pipeline mixin. Adds the full voice pipeline to an Agent class.
 *
 * Subclasses must set `stt` and `tts` provider properties. VAD is optional.
 *
 * @param Base - The Agent class to extend (e.g. `Agent`).
 * @param voiceOptions - Optional pipeline configuration.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoice, WorkersAISTT, WorkersAITTS, WorkersAIVAD } from "agents/experimental/voice";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * class MyAgent extends VoiceAgent<Env> {
 *   stt = new WorkersAISTT(this.env.AI);
 *   tts = new WorkersAITTS(this.env.AI);
 *   vad = new WorkersAIVAD(this.env.AI);
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
) {
  console.log(
    "[@cloudflare/voice] Note: The voice API is experimental and may change between releases. Pin your version to avoid surprises."
  );

  const opts = voiceOptions ?? {};

  function opt<K extends keyof VoiceAgentOptions>(
    key: K,
    fallback: NonNullable<VoiceAgentOptions[K]>
  ): NonNullable<VoiceAgentOptions[K]> {
    return (opts[key] ?? fallback) as NonNullable<VoiceAgentOptions[K]>;
  }

  class VoiceAgentMixin extends Base {
    // --- Provider properties (set by subclass) ---

    /** Speech-to-text provider (batch). Required unless streamingStt is set. */
    stt?: STTProvider;
    /** Streaming speech-to-text provider. Optional — if set, used instead of batch `stt`. */
    streamingStt?: StreamingSTTProvider;
    /** Text-to-speech provider. Required. May also implement StreamingTTSProvider. */
    tts?: TTSProvider & Partial<StreamingTTSProvider>;
    /** Voice activity detection provider. Optional — if unset, every end_of_speech is treated as confirmed. */
    vad?: VADProvider;

    // Shared per-connection audio state manager
    #cm = new AudioConnectionManager("VoiceAgent");

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

    // --- Hibernation helpers ---

    #setCallState(connection: Connection, inCall: boolean) {
      this._unsafe_setConnectionFlag(
        connection,
        "_cf_voiceInCall",
        inCall || undefined
      );
    }

    #getCallState(connection: Connection): boolean {
      return (
        this._unsafe_getConnectionFlag(connection, "_cf_voiceInCall") === true
      );
    }

    /**
     * Restore in-memory call state after hibernation wake.
     * Called when we receive a message for a connection that the state
     * says is in a call, but we have no in-memory buffer for it.
     */
    #restoreCallState(connection: Connection) {
      console.log(
        `[VoiceAgent] Restoring call state after hibernation wake: ${connection.id}`
      );
      this.#cm.initConnection(connection.id);
    }

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

      // Capture the consumer's lifecycle methods (defined on the subclass
      // prototype) and wrap them so voice logic always runs first.
      // This is the same pattern used by withVoiceInput, Agent, and PartyServer.

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
        console.log(`[VoiceAgent] Connected: ${connection.id}`);
        this.#sendJSON(connection, {
          type: "welcome",
          protocol_version: VOICE_PROTOCOL_VERSION
        });
        this.#sendJSON(connection, { type: "status", status: "idle" });
        return _onConnect?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onClose = (connection: Connection, ...rest: unknown[]) => {
        console.log(`[VoiceAgent] Disconnected: ${connection.id}`);
        this.#cm.cleanup(connection.id);
        this.#setCallState(connection, false);
        return _onClose?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onMessage = (
        connection: Connection,
        message: WSMessage
      ) => {
        // Restore in-memory state if DO woke from hibernation
        if (
          !this.#cm.isInCall(connection.id) &&
          this.#getCallState(connection)
        ) {
          this.#restoreCallState(connection);
        }

        // Binary audio — always handled by voice, never forwarded
        if (message instanceof ArrayBuffer) {
          this.#cm.bufferAudio(connection.id, message);
          return;
        }

        if (typeof message !== "string") {
          return _onMessage?.(connection, message);
        }

        // Try to parse as voice protocol
        let parsed: { type: string };
        try {
          parsed = JSON.parse(message);
        } catch {
          // Not JSON — forward to consumer
          return _onMessage?.(connection, message);
        }

        // Voice protocol message — handle internally
        if (VoiceAgentMixin.#VOICE_MESSAGES.has(parsed.type)) {
          console.log(
            `[VoiceAgent] <<< recv message type="${parsed.type}" from ${connection.id}`
          );

          switch (parsed.type) {
            case "hello":
              // Client announced its protocol version — log for diagnostics.
              break;
            case "start_call":
              this.#handleStartCall(
                connection,
                (parsed as { preferred_format?: string }).preferred_format
              );
              break;
            case "end_call":
              this.#handleEndCall(connection);
              break;
            case "start_of_speech":
              this.#handleStartOfSpeech(connection);
              break;
            case "end_of_speech":
              this.#cm.clearVadRetry(connection.id);
              this.#handleEndOfSpeech(connection);
              break;
            case "interrupt":
              this.#handleInterrupt(connection);
              break;
            case "text_message": {
              const text = (parsed as unknown as { text?: string }).text;
              if (typeof text === "string") {
                this.#handleTextMessage(connection, text);
              }
              break;
            }
          }
          return;
        }

        // Not a voice message — forward to consumer
        return _onMessage?.(connection, message);
      };
    }

    // --- User-overridable hooks ---

    onTurn(
      _transcript: string,
      _context: VoiceTurnContext
    ): Promise<TextSource> {
      throw new Error(
        "VoiceAgent subclass must implement onTurn(). Return a string, AsyncIterable<string>, or ReadableStream."
      );
    }

    beforeCallStart(_connection: Connection): boolean | Promise<boolean> {
      return true;
    }

    onCallStart(_connection: Connection): void | Promise<void> {}
    onCallEnd(_connection: Connection): void | Promise<void> {}
    onInterrupt(_connection: Connection): void | Promise<void> {}

    // --- Pipeline hooks ---

    beforeTranscribe(
      audio: ArrayBuffer,
      _connection: Connection
    ): ArrayBuffer | null | Promise<ArrayBuffer | null> {
      return audio;
    }

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

    // --- Streaming STT session management ---

    #handleStartOfSpeech(connection: Connection) {
      console.log(
        `[VoiceAgent] handleStartOfSpeech: hasStreamingStt=${!!this.streamingStt}, hasSession=${this.#cm.hasSTTSession(connection.id)}, inCall=${this.#cm.isInCall(connection.id)}`
      );
      if (!this.streamingStt) return; // no streaming provider — ignore
      if (this.#cm.hasSTTSession(connection.id)) return; // already active
      if (!this.#cm.isInCall(connection.id)) return; // not in a call

      // Clear EOT flag from any previous turn
      this.#cm.clearEOT(connection.id);

      // Accumulate finalized segments for the full transcript
      let accumulated = "";

      this.#cm.startSTTSession(connection.id, this.streamingStt, {
        onFinal: (text: string) => {
          accumulated += (accumulated ? " " : "") + text;
          // Send interim update with the accumulated final text
          this.#sendJSON(connection, {
            type: "transcript_interim",
            text: accumulated
          });
        },
        onInterim: (text: string) => {
          // Show accumulated finals + current interim to the client
          const display = accumulated ? accumulated + " " + text : text;
          this.#sendJSON(connection, {
            type: "transcript_interim",
            text: display
          });
        },
        // Provider-driven end-of-turn: start LLM+TTS immediately
        // without waiting for the client to send end_of_speech.
        onEndOfTurn: (transcript: string) => {
          console.log(
            `[VoiceAgent] session.onEndOfTurn fired: "${transcript}", alreadyTriggered=${this.#cm.isEOTTriggered(connection.id)}`
          );
          // Guard against double-fire
          if (this.#cm.isEOTTriggered(connection.id)) return;
          this.#cm.setEOTTriggered(connection.id);

          console.log(`[VoiceAgent] Provider-driven EOT: "${transcript}"`);

          // Remove the session — this turn is done
          this.#cm.removeSTTSession(connection.id);
          // Clear audio buffer — no batch STT needed
          this.#cm.clearAudioBuffer(connection.id);
          // Clear any pending VAD retry
          this.#cm.clearVadRetry(connection.id);

          // Start the pipeline immediately with the stable transcript
          this.#runPipeline(connection, transcript);
        }
      });

      console.log(
        `[VoiceAgent] Streaming STT session started: ${connection.id}`
      );
    }

    #requireTTS(): TTSProvider & Partial<StreamingTTSProvider> {
      if (!this.tts) {
        throw new Error(
          "No TTS provider configured. Set 'tts' on your VoiceAgent subclass."
        );
      }
      return this.tts;
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

    /**
     * Programmatically end a call for a specific connection.
     * Cleans up server-side state (audio buffers, pipelines, STT sessions,
     * keepalives) and sends the idle status to the client.
     * Use this to kick a speaker or enforce call limits.
     */
    forceEndCall(connection: Connection): void {
      if (!this.#cm.isInCall(connection.id)) return; // not in a call
      this.#handleEndCall(connection);
    }

    async speak(connection: Connection, text: string): Promise<void> {
      const signal = this.#cm.createPipelineAbort(connection.id);
      try {
        this.#sendJSON(connection, { type: "status", status: "speaking" });
        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, { type: "transcript_end", text });

        const audio = await this.#synthesizeWithHooks(text, connection, signal);
        if (audio && !signal.aborted) {
          connection.send(audio);
        }

        if (!signal.aborted) {
          this.saveMessage("assistant", text);
          this.#sendJSON(connection, { type: "status", status: "listening" });
        }
      } finally {
        this.#cm.clearPipelineAbort(connection.id);
      }
    }

    async speakAll(text: string): Promise<void> {
      this.saveMessage("assistant", text);

      const connections = [...this.getConnections()];
      if (connections.length === 0) {
        console.log(`[VoiceAgent] No clients connected — saved to history`);
        return;
      }

      for (const connection of connections) {
        const signal = this.#cm.createPipelineAbort(connection.id);
        try {
          this.#sendJSON(connection, { type: "status", status: "speaking" });
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
            connection.send(audio);
          }

          if (!signal.aborted) {
            this.#sendJSON(connection, {
              type: "status",
              status: "listening"
            });
          }
        } finally {
          this.#cm.clearPipelineAbort(connection.id);
        }
      }
    }

    async #synthesizeWithHooks(
      text: string,
      connection: Connection,
      signal?: AbortSignal
    ): Promise<ArrayBuffer | null> {
      const textToSpeak = await this.beforeSynthesize(text, connection);
      if (!textToSpeak) return null;
      const rawAudio = await this.#requireTTS().synthesize(textToSpeak, signal);
      return this.afterSynthesize(rawAudio, textToSpeak, connection);
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection, preferredFormat?: string) {
      const allowed = await this.beforeCallStart(connection);
      if (!allowed) return;

      console.log(`[VoiceAgent] Call started`);
      this.#cm.initConnection(connection.id);
      this.#setCallState(connection, true);

      const configuredFormat = opt("audioFormat", "mp3") as VoiceAudioFormat;
      if (preferredFormat && preferredFormat !== configuredFormat) {
        console.log(
          `[VoiceAgent] Client requested format "${preferredFormat}" but server is configured for "${configuredFormat}"`
        );
      }
      this.#sendJSON(connection, {
        type: "audio_config",
        format: configuredFormat
      });
      this.#sendJSON(connection, { type: "status", status: "listening" });

      await this.onCallStart(connection);
    }

    #handleEndCall(connection: Connection) {
      console.log(`[VoiceAgent] Call ended`);
      this.#cm.cleanup(connection.id);
      this.#setCallState(connection, false);
      this.#sendJSON(connection, { type: "status", status: "idle" });

      this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection) {
      console.log(`[VoiceAgent] Interrupted by user`);
      this.#cm.abortPipeline(connection.id);
      this.#cm.abortSTTSession(connection.id);
      this.#cm.clearVadRetry(connection.id);
      this.#cm.clearEOT(connection.id);
      this.#cm.clearAudioBuffer(connection.id);
      this.#sendJSON(connection, { type: "status", status: "listening" });

      this.onInterrupt(connection);
    }

    // --- Internal: text message handling ---

    async #handleTextMessage(connection: Connection, text: string) {
      if (!text || text.trim().length === 0) return;

      const userText = text.trim();
      console.log(`[VoiceAgent] Text message: "${userText}"`);

      const signal = this.#cm.createPipelineAbort(connection.id);

      const pipelineStart = Date.now();
      this.#sendJSON(connection, { type: "status", status: "thinking" });

      this.saveMessage("user", userText);
      this.#sendJSON(connection, {
        type: "transcript",
        role: "user",
        text: userText
      });

      try {
        const context: VoiceTurnContext = {
          connection,
          messages: this.getConversationHistory(),
          signal
        };

        const llmStart = Date.now();
        const turnResult = await this.onTurn(userText, context);

        if (signal.aborted) return;

        const isInCall = this.#cm.isInCall(connection.id);

        if (isInCall) {
          this.#sendJSON(connection, { type: "status", status: "speaking" });

          const { text: fullText } = await this.#streamResponse(
            connection,
            turnResult,
            llmStart,
            pipelineStart,
            signal
          );

          if (signal.aborted) return;
          this.saveMessage("assistant", fullText);
          this.#sendJSON(connection, { type: "status", status: "listening" });
        } else {
          this.#sendJSON(connection, {
            type: "transcript_start",
            role: "assistant"
          });
          let fullText = "";
          for await (const token of iterateText(turnResult)) {
            if (signal.aborted) break;
            fullText += token;
            this.#sendJSON(connection, {
              type: "transcript_delta",
              text: token
            });
          }
          this.#sendJSON(connection, {
            type: "transcript_end",
            text: fullText
          });
          this.saveMessage("assistant", fullText);
          this.#sendJSON(connection, { type: "status", status: "idle" });
        }
      } catch (error) {
        if (signal.aborted) return;
        console.error("[VoiceAgent] Text pipeline error:", error);
        this.#sendJSON(connection, {
          type: "error",
          message:
            error instanceof Error ? error.message : "Text pipeline failed"
        });
        this.#sendJSON(connection, {
          type: "status",
          status: this.#cm.isInCall(connection.id) ? "listening" : "idle"
        });
      } finally {
        this.#cm.clearPipelineAbort(connection.id);
      }
    }

    // --- Internal: audio pipeline ---

    async #handleEndOfSpeech(connection: Connection, skipVad = false) {
      console.log(
        `[VoiceAgent] handleEndOfSpeech: skipVad=${skipVad}, eotTriggered=${this.#cm.isEOTTriggered(connection.id)}, hasSTTSession=${this.#cm.hasSTTSession(connection.id)}`
      );
      // If the pipeline was already triggered by provider-driven EOT,
      // this end_of_speech from the client is late — ignore it.
      if (this.#cm.isEOTTriggered(connection.id)) {
        this.#cm.clearEOT(connection.id);
        console.log(
          `[VoiceAgent] Ignoring late end_of_speech — pipeline already triggered by provider EOT`
        );
        return;
      }

      const audioData = this.#cm.getAndClearAudio(connection.id);
      if (!audioData) {
        console.log(
          `[VoiceAgent] handleEndOfSpeech: no audio chunks buffered, ignoring`
        );
        return;
      }

      console.log(
        `[VoiceAgent] handleEndOfSpeech: ${audioData.byteLength} bytes`
      );

      const hasStreamingSession = this.#cm.hasSTTSession(connection.id);

      const minAudioBytes = opt("minAudioBytes", DEFAULT_MIN_AUDIO_BYTES);
      if (audioData.byteLength < minAudioBytes) {
        console.log(
          `[VoiceAgent] handleEndOfSpeech: audio too short (${audioData.byteLength} < ${minAudioBytes}), discarding`
        );
        // Too short — abort the streaming session if any
        this.#cm.abortSTTSession(connection.id);
        this.#sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      let vadMs = 0;

      if (this.vad && !skipVad) {
        const vadStart = Date.now();
        const vadResult = await this.vad.checkEndOfTurn(audioData);
        vadMs = Date.now() - vadStart;
        const vadThreshold = opt("vadThreshold", DEFAULT_VAD_THRESHOLD);
        const shouldProceed =
          vadResult.isComplete || vadResult.probability > vadThreshold;

        if (!shouldProceed) {
          console.log(
            `[VoiceAgent] VAD: not end-of-turn (prob=${vadResult.probability.toFixed(2)}), continuing`
          );
          const pushbackSeconds = opt(
            "vadPushbackSeconds",
            DEFAULT_VAD_PUSHBACK_SECONDS
          );
          const maxPushbackBytes = pushbackSeconds * 16000 * 2;
          const pushback =
            audioData.byteLength > maxPushbackBytes
              ? audioData.slice(audioData.byteLength - maxPushbackBytes)
              : audioData;
          this.#cm.pushbackAudio(connection.id, pushback);
          // Keep the streaming STT session alive — VAD rejected but user
          // may still be speaking. The session continues accumulating.
          this.#sendJSON(connection, { type: "status", status: "listening" });

          // Schedule a retry that skips VAD. If the user stays silent,
          // the client won't send another end_of_speech (its #isSpeaking
          // is already false), so we'd deadlock without this timer.
          this.#cm.scheduleVadRetry(
            connection.id,
            () => this.#handleEndOfSpeech(connection, true),
            opt("vadRetryMs", DEFAULT_VAD_RETRY_MS) as number
          );
          return;
        }

        console.log(
          `[VoiceAgent] VAD: end-of-turn confirmed (prob=${vadResult.probability.toFixed(2)})`
        );
      }

      // --- STT phase ---

      const signal = this.#cm.createPipelineAbort(connection.id);

      const sttStart = Date.now();
      this.#sendJSON(connection, { type: "status", status: "thinking" });

      try {
        let userText: string | null;
        let sttMs: number;

        if (hasStreamingSession) {
          // --- Streaming STT path ---
          // The session has been receiving audio all along.
          // finish() flushes and returns the final transcript (~50ms).
          // beforeTranscribe is skipped — audio was already fed incrementally.
          const rawTranscript = await this.#cm.flushSTTSession(connection.id);
          sttMs = Date.now() - sttStart;
          console.log(
            `[VoiceAgent] Streaming STT flush: ${sttMs}ms → "${rawTranscript}"`
          );

          if (signal.aborted) return;

          if (!rawTranscript || rawTranscript.trim().length === 0) {
            this.#sendJSON(connection, {
              type: "status",
              status: "listening"
            });
            return;
          }

          userText = await this.afterTranscribe(rawTranscript, connection);
        } else {
          // --- Batch STT path (original) ---
          if (!this.stt) {
            // No batch STT provider and no streaming session — this can
            // happen when onEndOfTurn already consumed the session.
            // Just return to listening.
            console.log(
              `[VoiceAgent] handleEndOfSpeech: no streaming session and no batch STT provider, returning to listening`
            );
            this.#sendJSON(connection, {
              type: "status",
              status: "listening"
            });
            return;
          }

          const processedAudio = await this.beforeTranscribe(
            audioData,
            connection
          );
          if (!processedAudio || signal.aborted) {
            this.#sendJSON(connection, {
              type: "status",
              status: "listening"
            });
            return;
          }

          const rawTranscript = await this.stt.transcribe(
            processedAudio,
            signal
          );
          sttMs = Date.now() - sttStart;
          console.log(`[VoiceAgent] STT: ${sttMs}ms → "${rawTranscript}"`);

          if (signal.aborted) return;

          if (!rawTranscript || rawTranscript.trim().length === 0) {
            this.#sendJSON(connection, {
              type: "status",
              status: "listening"
            });
            return;
          }

          userText = await this.afterTranscribe(rawTranscript, connection);
        }

        if (!userText || signal.aborted) {
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        // Hand off to the shared pipeline (LLM + TTS)
        await this.#runPipelineInner(
          connection,
          userText,
          sttStart,
          vadMs,
          sttMs,
          signal
        );
      } catch (error) {
        if (signal.aborted) return;
        console.error("[VoiceAgent] Pipeline error:", error);
        this.#sendJSON(connection, {
          type: "error",
          message:
            error instanceof Error ? error.message : "Voice pipeline failed"
        });
        this.#sendJSON(connection, { type: "status", status: "listening" });
      } finally {
        this.#cm.clearPipelineAbort(connection.id);
      }
    }

    /**
     * Start the voice pipeline from a stable transcript.
     * Called by provider-driven EOT (onEndOfTurn callback).
     * Handles: abort controller setup, LLM, TTS, metrics, persistence.
     */
    async #runPipeline(connection: Connection, transcript: string) {
      const signal = this.#cm.createPipelineAbort(connection.id);

      const pipelineStart = Date.now();

      try {
        const userText = await this.afterTranscribe(transcript, connection);
        if (!userText || signal.aborted) {
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        await this.#runPipelineInner(
          connection,
          userText,
          pipelineStart,
          0, // vadMs — no VAD with provider-driven EOT
          0, // sttMs — transcript was delivered instantly by EOT
          signal
        );
      } catch (error) {
        if (signal.aborted) return;
        console.error("[VoiceAgent] Pipeline error:", error);
        this.#sendJSON(connection, {
          type: "error",
          message:
            error instanceof Error ? error.message : "Voice pipeline failed"
        });
        this.#sendJSON(connection, { type: "status", status: "listening" });
      } finally {
        this.#cm.clearPipelineAbort(connection.id);
      }
    }

    /**
     * Shared inner pipeline: save transcript, run LLM, stream TTS, emit metrics.
     * Used by both #handleEndOfSpeech (after STT) and #runPipeline (after provider EOT).
     */
    async #runPipelineInner(
      connection: Connection,
      userText: string,
      pipelineStart: number,
      vadMs: number,
      sttMs: number,
      signal: AbortSignal
    ) {
      this.saveMessage("user", userText);
      this.#sendJSON(connection, {
        type: "transcript",
        role: "user",
        text: userText
      });

      this.#sendJSON(connection, { type: "status", status: "speaking" });

      const context: VoiceTurnContext = {
        connection,
        messages: this.getConversationHistory(),
        signal
      };

      const llmStart = Date.now();
      const turnResult = await this.onTurn(userText, context);

      if (signal.aborted) return;

      const {
        text: fullText,
        llmMs,
        ttsMs,
        firstAudioMs
      } = await this.#streamResponse(
        connection,
        turnResult,
        llmStart,
        pipelineStart,
        signal
      );

      if (signal.aborted) return;

      const totalMs = Date.now() - pipelineStart;
      console.log(
        `[VoiceAgent] Pipeline: VAD ${vadMs}ms / STT ${sttMs}ms / LLM ${llmMs}ms / TTS ${ttsMs}ms / first-audio ${firstAudioMs}ms / total ${totalMs}ms`
      );

      this.#sendJSON(connection, {
        type: "metrics",
        vad_ms: vadMs,
        stt_ms: sttMs,
        llm_ms: llmMs,
        tts_ms: ttsMs,
        first_audio_ms: firstAudioMs,
        total_ms: totalMs
      });

      this.saveMessage("assistant", fullText);

      this.#sendJSON(connection, { type: "status", status: "listening" });
    }

    // --- Internal: streaming TTS pipeline ---

    async #streamResponse(
      connection: Connection,
      response: TextSource,
      llmStart: number,
      pipelineStart: number,
      signal: AbortSignal
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstAudioMs: number;
    }> {
      if (typeof response === "string") {
        const llmMs = Date.now() - llmStart;

        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, {
          type: "transcript_end",
          text: response
        });

        const ttsStart = Date.now();
        const audio = await this.#synthesizeWithHooks(response, connection);
        const ttsMs = Date.now() - ttsStart;

        if (audio && !signal.aborted) {
          connection.send(audio);
        }

        const firstAudioMs = Date.now() - pipelineStart;
        return { text: response, llmMs, ttsMs, firstAudioMs };
      }

      return this.#streamingTTSPipeline(
        connection,
        iterateText(response),
        llmStart,
        pipelineStart,
        signal
      );
    }

    async #streamingTTSPipeline(
      connection: Connection,
      tokenStream: AsyncIterable<string>,
      llmStart: number,
      pipelineStart: number,
      signal: AbortSignal
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstAudioMs: number;
    }> {
      const chunker = new SentenceChunker();
      const ttsQueue: AsyncIterable<ArrayBuffer>[] = [];
      let fullText = "";
      let firstAudioSentAt: number | null = null;
      let cumulativeTtsMs = 0;

      let streamComplete = false;
      let drainNotify: (() => void) | null = null;
      let drainPending = false;

      const notifyDrain = () => {
        if (drainNotify) {
          const resolve = drainNotify;
          drainNotify = null;
          resolve();
        } else {
          drainPending = true;
        }
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
              connection.send(chunk);
              if (!firstAudioSentAt) {
                firstAudioSentAt = Date.now();
              }
            }
          } catch (err) {
            console.error("[VoiceAgent] TTS error for sentence:", err);
            this.#sendJSON(connection, {
              type: "error",
              message:
                err instanceof Error ? err.message : "TTS failed for a sentence"
            });
          }
          i++;
        }
      })();

      const makeSentenceTTS = (
        sentence: string
      ): AsyncIterable<ArrayBuffer> => {
        const self = this;
        async function* generate() {
          const ttsStart = Date.now();
          const text = await self.beforeSynthesize(sentence, connection);
          if (!text) return;

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
          cumulativeTtsMs += Date.now() - ttsStart;
        }

        return eagerAsyncIterable(generate());
      };

      const enqueueSentence = (sentence: string) => {
        ttsQueue.push(makeSentenceTTS(sentence));
        notifyDrain();
      };

      this.#sendJSON(connection, {
        type: "transcript_start",
        role: "assistant"
      });

      for await (const token of tokenStream) {
        if (signal.aborted) break;

        fullText += token;
        this.#sendJSON(connection, { type: "transcript_delta", text: token });

        const sentences = chunker.add(token);
        for (const sentence of sentences) {
          enqueueSentence(sentence);
        }
      }

      const llmMs = Date.now() - llmStart;

      const remaining = chunker.flush();
      for (const sentence of remaining) {
        enqueueSentence(sentence);
      }

      streamComplete = true;
      notifyDrain();
      this.#sendJSON(connection, { type: "transcript_end", text: fullText });

      await drainPromise;

      const firstAudioMs = firstAudioSentAt
        ? firstAudioSentAt - pipelineStart
        : 0;

      return { text: fullText, llmMs, ttsMs: cumulativeTtsMs, firstAudioMs };
    }

    // --- Internal: protocol helpers ---

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

  return VoiceAgentMixin;
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
