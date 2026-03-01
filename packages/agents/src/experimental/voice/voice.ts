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

import type { Agent, Connection, WSMessage } from "../../index";
import { SentenceChunker } from "./sentence-chunker";
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
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions
} from "./types";

console.warn(
  "[agents/experimental/voice] WARNING: You are using an experimental API that WILL break between releases. Do not use in production."
);

// Re-export SentenceChunker for direct use
export { SentenceChunker } from "./sentence-chunker";

// Re-export protocol version constant
export { VOICE_PROTOCOL_VERSION } from "./types";

// Re-export shared types so existing imports from "agents/experimental/voice" still work
export type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
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

// Re-export Workers AI providers and audio utility
export {
  WorkersAISTT,
  WorkersAITTS,
  WorkersAIVAD,
  pcmToWav
} from "./workers-ai-providers";
export type {
  WorkersAISTTOptions,
  WorkersAITTSOptions,
  WorkersAIVADOptions
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
export interface VoiceAgentOptions {
  /** Minimum audio bytes to process (16kHz mono 16-bit). @default 16000 (0.5s) */
  minAudioBytes?: number;
  /** Max conversation history messages loaded for context. @default 20 */
  historyLimit?: number;
  /** Audio format used for binary audio payloads sent to the client. @default "mp3" */
  audioFormat?: VoiceAudioFormat;
  /** VAD probability threshold — only used when `vad` is set. @default 0.5 */
  vadThreshold?: number;
  /** Seconds of audio to push back to buffer when VAD rejects. @default 2 */
  vadPushbackSeconds?: number;
  /** Max conversation messages to keep in SQLite. Oldest are pruned. @default 1000 */
  maxMessageCount?: number;
}

// --- Audio utilities (internal) ---

function concatenateBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}

// --- Default option values ---

const DEFAULT_VAD_THRESHOLD = 0.5;
const DEFAULT_MIN_AUDIO_BYTES = 16000; // 0.5s at 16kHz mono 16-bit
const DEFAULT_VAD_PUSHBACK_SECONDS = 2;
const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_COUNT = 1000;

// Max audio buffer size per connection: 30 seconds at 16kHz mono 16-bit = 960KB.
const MAX_AUDIO_BUFFER_BYTES = 960_000;

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<
  Pick<Agent<Cloudflare.Env>, "sql" | "getConnections">
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

    // Per-connection audio buffers (not persisted — lost on hibernation)
    #audioBuffers = new Map<string, ArrayBuffer[]>();

    // Per-connection pipeline abort controllers
    #activePipeline = new Map<string, AbortController>();

    // Per-connection keepalive timers — prevent DO hibernation during active calls.
    #keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();

    // Per-connection streaming STT sessions (active during speech)
    #sttSessions = new Map<string, StreamingSTTSession>();

    // --- Hibernation helpers ---

    #setCallState(connection: Connection, inCall: boolean) {
      const existing =
        connection.deserializeAttachment<Record<string, unknown>>() ?? {};
      connection.serializeAttachment({ ...existing, _voiceInCall: inCall });
    }

    #getCallState(connection: Connection): boolean {
      const attachment = connection.deserializeAttachment<{
        _voiceInCall?: boolean;
      }>();
      return attachment?._voiceInCall === true;
    }

    /**
     * Restore in-memory call state after hibernation wake.
     * Called when we receive a message for a connection that the attachment
     * says is in a call, but we have no in-memory buffer for it.
     */
    #restoreCallState(connection: Connection) {
      console.log(
        `[VoiceAgent] Restoring call state after hibernation wake: ${connection.id}`
      );
      this.#audioBuffers.set(connection.id, []);
      this.#startKeepalive(connection.id);
    }

    // --- Agent lifecycle ---

    /**
     * Creates the conversation history table on startup.
     * If you override `onStart()`, call `super.onStart()` to preserve this.
     */
    onStart() {
      this.sql`
        CREATE TABLE IF NOT EXISTS cf_voice_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `;
    }

    onConnect(connection: Connection) {
      console.log(`[VoiceAgent] Connected: ${connection.id}`);
      this.#sendJSON(connection, {
        type: "welcome",
        protocol_version: VOICE_PROTOCOL_VERSION
      });
      this.#sendJSON(connection, { type: "status", status: "idle" });
    }

    onClose(connection: Connection) {
      console.log(`[VoiceAgent] Disconnected: ${connection.id}`);
      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);
      this.#audioBuffers.delete(connection.id);
      this.#abortSTTSession(connection.id);
      this.#stopKeepalive(connection.id);
      this.#setCallState(connection, false);
    }

    onMessage(connection: Connection, message: WSMessage) {
      // Restore in-memory state if DO woke from hibernation
      if (
        !this.#audioBuffers.has(connection.id) &&
        this.#getCallState(connection)
      ) {
        this.#restoreCallState(connection);
      }

      if (message instanceof ArrayBuffer) {
        this.#handleAudioChunk(connection, message);
        return;
      }

      if (typeof message !== "string") return;

      let parsed: { type: string };
      try {
        parsed = JSON.parse(message);
      } catch {
        this.onNonVoiceMessage(connection, message);
        return;
      }

      switch (parsed.type) {
        case "hello":
          // Client announced its protocol version — log for diagnostics.
          // Future: negotiate capabilities based on version.
          break;
        case "start_call":
          this.#handleStartCall(connection);
          break;
        case "end_call":
          this.#handleEndCall(connection);
          break;
        case "start_of_speech":
          this.#handleStartOfSpeech(connection);
          break;
        case "end_of_speech":
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
        default:
          this.onNonVoiceMessage(connection, message);
          break;
      }
    }

    // --- User-overridable hooks ---

    onTurn(
      _transcript: string,
      _context: VoiceTurnContext
    ): Promise<string | AsyncIterable<string>> {
      throw new Error(
        "VoiceAgent subclass must implement onTurn(). Return a string or AsyncIterable<string>."
      );
    }

    beforeCallStart(_connection: Connection): boolean | Promise<boolean> {
      return true;
    }

    onCallStart(_connection: Connection): void | Promise<void> {}
    onCallEnd(_connection: Connection): void | Promise<void> {}
    onInterrupt(_connection: Connection): void | Promise<void> {}

    onNonVoiceMessage(
      _connection: Connection,
      _message: WSMessage
    ): void | Promise<void> {}

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

    // --- Provider helpers (internal) ---

    #requireSTT(): STTProvider {
      if (!this.stt) {
        throw new Error(
          "No STT provider configured. Set 'stt' or 'streamingStt' on your VoiceAgent subclass."
        );
      }
      return this.stt;
    }

    // --- Streaming STT session management ---

    #handleStartOfSpeech(connection: Connection) {
      if (!this.streamingStt) return; // no streaming provider — ignore
      if (this.#sttSessions.has(connection.id)) return; // already active
      if (!this.#audioBuffers.has(connection.id)) return; // not in a call

      const session = this.streamingStt.createSession();

      // Accumulate finalized segments for the full transcript
      let accumulated = "";
      session.onFinal = (text: string) => {
        accumulated += (accumulated ? " " : "") + text;
        // Send interim update with the accumulated final text
        this.#sendJSON(connection, {
          type: "transcript_interim",
          text: accumulated
        });
      };

      session.onInterim = (text: string) => {
        // Show accumulated finals + current interim to the client
        const display = accumulated ? accumulated + " " + text : text;
        this.#sendJSON(connection, {
          type: "transcript_interim",
          text: display
        });
      };

      this.#sttSessions.set(connection.id, session);
      console.log(
        `[VoiceAgent] Streaming STT session started: ${connection.id}`
      );
    }

    #abortSTTSession(connectionId: string) {
      const session = this.#sttSessions.get(connectionId);
      if (session) {
        session.abort();
        this.#sttSessions.delete(connectionId);
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

    // --- Conversation persistence ---

    saveMessage(role: "user" | "assistant", text: string) {
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
      if (!this.#audioBuffers.has(connection.id)) return; // not in a call
      this.#handleEndCall(connection);
    }

    async speak(connection: Connection, text: string): Promise<void> {
      this.#sendJSON(connection, { type: "status", status: "speaking" });
      this.#sendJSON(connection, {
        type: "transcript_start",
        role: "assistant"
      });
      this.#sendJSON(connection, { type: "transcript_end", text });

      const audio = await this.#synthesizeWithHooks(text, connection);
      if (audio) {
        connection.send(audio);
      }

      this.saveMessage("assistant", text);

      this.#sendJSON(connection, { type: "status", status: "listening" });
    }

    async speakAll(text: string): Promise<void> {
      this.saveMessage("assistant", text);

      const connections = [...this.getConnections()];
      if (connections.length === 0) {
        console.log(`[VoiceAgent] No clients connected — saved to history`);
        return;
      }

      for (const connection of connections) {
        this.#sendJSON(connection, { type: "status", status: "speaking" });
        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, { type: "transcript_end", text });

        const audio = await this.#synthesizeWithHooks(text, connection);
        if (audio) {
          connection.send(audio);
        }

        this.#sendJSON(connection, { type: "status", status: "listening" });
      }
    }

    async #synthesizeWithHooks(
      text: string,
      connection: Connection
    ): Promise<ArrayBuffer | null> {
      const textToSpeak = await this.beforeSynthesize(text, connection);
      if (!textToSpeak) return null;
      const rawAudio = await this.#requireTTS().synthesize(textToSpeak);
      return this.afterSynthesize(rawAudio, textToSpeak, connection);
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection) {
      const allowed = await this.beforeCallStart(connection);
      if (!allowed) return;

      console.log(`[VoiceAgent] Call started`);
      this.#audioBuffers.set(connection.id, []);
      this.#startKeepalive(connection.id);
      this.#setCallState(connection, true);

      const audioFormat = opt("audioFormat", "mp3") as VoiceAudioFormat;
      this.#sendJSON(connection, {
        type: "audio_config",
        format: audioFormat
      });
      this.#sendJSON(connection, { type: "status", status: "listening" });

      await this.onCallStart(connection);
    }

    #handleEndCall(connection: Connection) {
      console.log(`[VoiceAgent] Call ended`);
      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);
      this.#audioBuffers.delete(connection.id);
      this.#abortSTTSession(connection.id);
      this.#stopKeepalive(connection.id);
      this.#setCallState(connection, false);
      this.#sendJSON(connection, { type: "status", status: "idle" });

      this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection) {
      console.log(`[VoiceAgent] Interrupted by user`);
      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);
      this.#abortSTTSession(connection.id);
      this.#audioBuffers.set(connection.id, []);
      this.#sendJSON(connection, { type: "status", status: "listening" });

      this.onInterrupt(connection);
    }

    // --- Internal: text message handling ---

    async #handleTextMessage(connection: Connection, text: string) {
      if (!text || text.trim().length === 0) return;

      const userText = text.trim();
      console.log(`[VoiceAgent] Text message: "${userText}"`);

      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);

      const abortController = new AbortController();
      this.#activePipeline.set(connection.id, abortController);
      const { signal } = abortController;

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

        const isInCall = this.#audioBuffers.has(connection.id);

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
          if (typeof turnResult === "string") {
            this.#sendJSON(connection, {
              type: "transcript_start",
              role: "assistant"
            });
            this.#sendJSON(connection, {
              type: "transcript_end",
              text: turnResult
            });
            this.saveMessage("assistant", turnResult);
          } else {
            this.#sendJSON(connection, {
              type: "transcript_start",
              role: "assistant"
            });
            let fullText = "";
            for await (const token of turnResult) {
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
          }
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
          status: this.#audioBuffers.has(connection.id) ? "listening" : "idle"
        });
      } finally {
        this.#activePipeline.delete(connection.id);
      }
    }

    // --- Internal: audio pipeline ---

    #handleAudioChunk(connection: Connection, chunk: ArrayBuffer) {
      const buffer = this.#audioBuffers.get(connection.id);
      if (!buffer) return;
      buffer.push(chunk);

      let totalBytes = 0;
      for (const buf of buffer) totalBytes += buf.byteLength;
      while (totalBytes > MAX_AUDIO_BUFFER_BYTES && buffer.length > 1) {
        totalBytes -= buffer.shift()!.byteLength;
      }

      // Feed to streaming STT session if active.
      // Auto-create session if streamingStt is set but client didn't send
      // start_of_speech (backward compat with old clients / SFU / Twilio).
      if (this.streamingStt && !this.#sttSessions.has(connection.id)) {
        this.#handleStartOfSpeech(connection);
      }
      const session = this.#sttSessions.get(connection.id);
      if (session) {
        session.feed(chunk);
      }
    }

    async #handleEndOfSpeech(connection: Connection) {
      const chunks = this.#audioBuffers.get(connection.id);
      if (!chunks || chunks.length === 0) return;

      const audioData = concatenateBuffers(chunks);
      this.#audioBuffers.set(connection.id, []);

      const hasStreamingSession = this.#sttSessions.has(connection.id);

      const minAudioBytes = opt("minAudioBytes", DEFAULT_MIN_AUDIO_BYTES);
      if (audioData.byteLength < minAudioBytes) {
        // Too short — abort the streaming session if any
        this.#abortSTTSession(connection.id);
        this.#sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      let vadMs = 0;

      if (this.vad) {
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
          const buffer = this.#audioBuffers.get(connection.id);
          if (buffer) {
            buffer.unshift(pushback);
          } else {
            this.#audioBuffers.set(connection.id, [pushback]);
          }
          // Keep the streaming STT session alive — VAD rejected but user
          // may still be speaking. The session continues accumulating.
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        console.log(
          `[VoiceAgent] VAD: end-of-turn confirmed (prob=${vadResult.probability.toFixed(2)})`
        );
      }

      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);

      const abortController = new AbortController();
      this.#activePipeline.set(connection.id, abortController);
      const { signal } = abortController;

      const pipelineStart = Date.now();
      this.#sendJSON(connection, { type: "status", status: "thinking" });

      try {
        let userText: string | null;
        let sttMs: number;

        if (hasStreamingSession) {
          // --- Streaming STT path ---
          // The session has been receiving audio all along.
          // finish() flushes and returns the final transcript (~50ms).
          // beforeTranscribe is skipped — audio was already fed incrementally.
          const session = this.#sttSessions.get(connection.id);
          const sttStart = Date.now();
          const rawTranscript = session ? await session.finish() : "";
          sttMs = Date.now() - sttStart;
          this.#sttSessions.delete(connection.id);
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

          const sttStart = Date.now();
          const rawTranscript = await this.#requireSTT().transcribe(
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
        this.#activePipeline.delete(connection.id);
      }
    }

    // --- Internal: streaming TTS pipeline ---

    async #streamResponse(
      connection: Connection,
      response: string | AsyncIterable<string>,
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
        response,
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

    // --- Internal: keepalive ---

    #startKeepalive(connectionId: string) {
      this.#stopKeepalive(connectionId);
      this.#keepaliveTimers.set(
        connectionId,
        setInterval(() => {
          /* keepalive tick */
        }, 5_000)
      );
    }

    #stopKeepalive(connectionId: string) {
      const timer = this.#keepaliveTimers.get(connectionId);
      if (timer) {
        clearInterval(timer);
        this.#keepaliveTimers.delete(connectionId);
      }
    }

    // --- Internal: protocol helpers ---

    #sendJSON(connection: Connection, data: unknown) {
      connection.send(JSON.stringify(data));
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
