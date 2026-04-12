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
 *       return result.textStream;
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
import { iterateText, type TextSource } from "./text-stream";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type {
  VoiceRole,
  VoiceAudioFormat,
  TTSProvider,
  StreamingTTSProvider,
  Transcriber
} from "./types";
import { AudioConnectionManager, sendVoiceJSON } from "./audio-pipeline";

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
export { withVoiceInput } from "./voice-input";

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
  messages: Array<{ role: VoiceRole; content: string }>;
  signal: AbortSignal;
}

/** Configuration options for the voice mixin. Passed to `withVoice()`. */
export interface VoiceAgentOptions {
  /** Max conversation history messages loaded for context. @default 20 */
  historyLimit?: number;
  /** Audio format used for binary audio payloads sent to the client. @default "mp3" */
  audioFormat?: VoiceAudioFormat;
  /** Max conversation messages to keep in SQLite. Oldest are pruned. @default 1000 */
  maxMessageCount?: number;
}

// --- Default option values ---

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_COUNT = 1000;

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<
  Pick<Agent<Cloudflare.Env>, "sql" | "getConnections" | "keepAlive">
>;

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
          protocol_version: VOICE_PROTOCOL_VERSION
        });
        this.#sendJSON(connection, { type: "status", status: "idle" });
        return _onConnect?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onClose = (connection: Connection, ...rest: unknown[]) => {
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
              this.#handleStartCall(
                connection,
                (parsed as { preferred_format?: string }).preferred_format
              );
              break;
            case "end_call":
              this.#handleEndCall(connection);
              break;
            case "start_of_speech":
            case "end_of_speech":
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
      if (connections.length === 0) return;

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
      signal?: AbortSignal
    ): Promise<ArrayBuffer | null> {
      const textToSpeak = await this.beforeSynthesize(text, connection);
      if (!textToSpeak) return null;
      const rawAudio = await this.#requireTTS().synthesize(textToSpeak, signal);
      return this.afterSynthesize(rawAudio, textToSpeak, connection);
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection, _preferredFormat?: string) {
      if (this.#cm.isInCall(connection.id)) return;

      const allowed = await this.beforeCallStart(connection);
      if (!allowed) return;

      const provider = this.createTranscriber(connection) ?? this.transcriber;
      if (!provider) {
        this.#sendJSON(connection, {
          type: "error",
          message:
            "No transcriber configured. Set 'transcriber' on your VoiceAgent subclass or override createTranscriber()."
        });
        return;
      }

      this.#cm.initConnection(connection.id);

      const dispose = await this.keepAlive();
      this.#keepAliveDispose.set(connection.id, dispose);

      const configuredFormat = opt("audioFormat", "mp3") as VoiceAudioFormat;
      this.#sendJSON(connection, {
        type: "audio_config",
        format: configuredFormat
      });

      this.#cm.startTranscriberSession(connection.id, provider, {
        onInterim: (text: string) => {
          this.#sendJSON(connection, {
            type: "transcript_interim",
            text
          });
        },
        onUtterance: (transcript: string) => {
          this.#sendJSON(connection, {
            type: "transcript_interim",
            text: ""
          });
          this.#runPipeline(connection, transcript);
        }
      });

      this.#sendJSON(connection, { type: "status", status: "listening" });
      await this.onCallStart(connection);
    }

    #releaseKeepAlive(connectionId: string) {
      const dispose = this.#keepAliveDispose.get(connectionId);
      if (dispose) {
        dispose();
        this.#keepAliveDispose.delete(connectionId);
      }
    }

    #handleEndCall(connection: Connection) {
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      this.#sendJSON(connection, { type: "status", status: "idle" });
      this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection) {
      this.#cm.abortPipeline(connection.id);
      this.#cm.clearAudioBuffer(connection.id);
      this.#sendJSON(connection, { type: "status", status: "listening" });
      this.onInterrupt(connection);
    }

    // --- Internal: text message handling ---

    async #handleTextMessage(connection: Connection, text: string) {
      if (!text || text.trim().length === 0) return;

      const userText = text.trim();
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

          if (fullText && fullText.trim().length > 0) {
            this.saveMessage("assistant", fullText);
          }
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

          if (fullText && fullText.trim().length > 0) {
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
          status: this.#cm.isInCall(connection.id) ? "listening" : "idle"
        });
      } finally {
        this.#cm.clearPipelineAbort(connection.id, signal);
      }
    }

    // --- Internal: voice pipeline ---

    async #runPipeline(connection: Connection, transcript: string) {
      const signal = this.#cm.createPipelineAbort(connection.id);
      const pipelineStart = Date.now();

      try {
        const userText = await this.afterTranscribe(transcript, connection);
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

        if (!fullText || fullText.trim().length === 0) {
          this.#sendJSON(connection, {
            type: "error",
            message: "No response generated"
          });
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const totalMs = Date.now() - pipelineStart;

        this.#sendJSON(connection, {
          type: "metrics",
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
        this.#cm.clearPipelineAbort(connection.id, signal);
      }
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
            if (signal.aborted) return;
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
