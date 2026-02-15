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

console.warn(
  "[agents/experimental/voice] WARNING: You are using an experimental API that WILL break between releases. Do not use in production."
);

// Re-export SentenceChunker for direct use
export { SentenceChunker } from "./sentence-chunker";

// --- Public types ---

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

/** Result from a VAD (Voice Activity Detection) provider. */
export interface VADResult {
  isComplete: boolean;
  probability: number;
}

/** Context passed to the `onTurn()` hook. */
export interface VoiceTurnContext {
  /** The WebSocket connection that sent the audio. */
  connection: Connection;
  /** Conversation history from SQLite (chronological order). */
  messages: Array<{ role: string; content: string }>;
  /** AbortSignal — aborted if user interrupts or disconnects. */
  signal: AbortSignal;
}

/** Pipeline latency metrics sent to the client after each turn. */
export interface VoicePipelineMetrics {
  vad_ms: number;
  stt_ms: number;
  llm_ms: number;
  tts_ms: number;
  first_audio_ms: number;
  total_ms: number;
}

/** Configuration options for the voice mixin. Passed to `withVoice()`. */
export interface VoiceAgentOptions {
  /** STT model name for Workers AI. @default "@cf/deepgram/nova-3" */
  sttModel?: string;
  /** STT language code (e.g. "en", "es", "fr"). @default "en" */
  language?: string;
  /** TTS model name for Workers AI. @default "@cf/deepgram/aura-1" */
  ttsModel?: string;
  /** TTS speaker voice. @default "asteria" */
  ttsSpeaker?: string;
  /** VAD model name for Workers AI. @default "@cf/pipecat-ai/smart-turn-v2" */
  vadModel?: string;
  /** VAD probability threshold. @default 0.5 */
  vadThreshold?: number;
  /** Minimum audio bytes to process (16kHz mono 16-bit). @default 16000 (0.5s) */
  minAudioBytes?: number;
  /** VAD audio window in seconds (uses last N seconds). @default 2 */
  vadWindowSeconds?: number;
  /** Max conversation history messages loaded for context. @default 20 */
  historyLimit?: number;
}

// --- Provider interfaces ---

/** Speech-to-text provider interface. */
export interface STTProvider {
  transcribe(audio: ArrayBuffer): Promise<string>;
}

/** Text-to-speech provider interface. */
export interface TTSProvider {
  synthesize(text: string): Promise<ArrayBuffer | null>;
}

/** Voice activity detection provider interface. */
export interface VADProvider {
  checkEndOfTurn(audio: ArrayBuffer): Promise<VADResult>;
}

/**
 * Streaming TTS provider interface.
 * Providers that support streaming return audio chunks as they are generated,
 * reducing time-to-first-audio within each sentence.
 */
export interface StreamingTTSProvider {
  synthesizeStream(text: string): AsyncIterable<ArrayBuffer>;
}

// --- Audio utilities (internal) ---

function toStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    }
  });
}

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

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function pcmToWav(
  pcmData: ArrayBuffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): ArrayBuffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmData.byteLength;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, headerSize).set(new Uint8Array(pcmData));

  return buffer;
}

// --- Default option values ---

const DEFAULT_STT_MODEL = "@cf/deepgram/nova-3";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_TTS_MODEL = "@cf/deepgram/aura-1";
const DEFAULT_VAD_MODEL = "@cf/pipecat-ai/smart-turn-v2";
const DEFAULT_TTS_SPEAKER = "asteria";
const DEFAULT_VAD_THRESHOLD = 0.5;
const DEFAULT_MIN_AUDIO_BYTES = 16000; // 0.5s at 16kHz mono 16-bit
const DEFAULT_VAD_WINDOW_SECONDS = 2;
const DEFAULT_HISTORY_LIMIT = 20;

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
 * @param Base - The Agent class to extend (e.g. `Agent`).
 * @param voiceOptions - Optional pipeline configuration (models, thresholds, etc.).
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoice } from "agents/experimental/voice";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * class MyAgent extends VoiceAgent<Env> {
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
    // --- Protected member accessors ---
    // TypeScript mixins lose protected members from the base class.
    // These helpers re-expose the ones that voice agents commonly need.

    // Per-connection audio buffers (not persisted)
    #audioBuffers = new Map<string, ArrayBuffer[]>();

    // Per-connection pipeline abort controllers
    #activePipeline = new Map<string, AbortController>();

    // Per-connection keepalive timers — prevent DO hibernation during active calls.
    #keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();

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
      this.#sendJSON(connection, { type: "status", status: "idle" });
    }

    onClose(connection: Connection) {
      console.log(`[VoiceAgent] Disconnected: ${connection.id}`);
      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);
      this.#audioBuffers.delete(connection.id);
      this.#stopKeepalive(connection.id);
    }

    onMessage(connection: Connection, message: WSMessage) {
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
        case "start_call":
          this.#handleStartCall(connection);
          break;
        case "end_call":
          this.#handleEndCall(connection);
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

    // --- STT / TTS / VAD (overridable for custom providers) ---

    async transcribe(audioData: ArrayBuffer): Promise<string> {
      const wavBuffer = pcmToWav(audioData, 16000, 1, 16);
      const model = opt("sttModel", DEFAULT_STT_MODEL);
      const language = opt("language", DEFAULT_LANGUAGE);

      const ai = (this as unknown as { env: { AI: { run: Ai["run"] } } }).env
        .AI;
      const result = (await ai.run(model as Parameters<typeof ai.run>[0], {
        audio: {
          body: toStream(wavBuffer),
          contentType: "audio/wav"
        },
        language,
        punctuate: true,
        smart_format: true
      })) as {
        results?: {
          channels?: Array<{
            alternatives?: Array<{
              transcript?: string;
            }>;
          }>;
        };
      };

      return (
        result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ""
      );
    }

    async synthesize(text: string): Promise<ArrayBuffer | null> {
      const model = opt("ttsModel", DEFAULT_TTS_MODEL);
      const speaker = opt("ttsSpeaker", DEFAULT_TTS_SPEAKER);

      try {
        const ai = (this as unknown as { env: { AI: { run: Ai["run"] } } }).env
          .AI;
        const response = (await ai.run(
          model as Parameters<typeof ai.run>[0],
          { text, speaker },
          { returnRawResponse: true }
        )) as Response;

        return await response.arrayBuffer();
      } catch (error) {
        console.error("[VoiceAgent] TTS error:", error);
        return null;
      }
    }

    synthesizeStream?(text: string): AsyncIterable<ArrayBuffer>;

    async checkEndOfTurn(audioData: ArrayBuffer): Promise<VADResult> {
      const vadWindowSeconds = opt(
        "vadWindowSeconds",
        DEFAULT_VAD_WINDOW_SECONDS
      );
      const model = opt("vadModel", DEFAULT_VAD_MODEL);

      try {
        const maxBytes = vadWindowSeconds * 16000 * 2;
        const vadAudio =
          audioData.byteLength > maxBytes
            ? audioData.slice(audioData.byteLength - maxBytes)
            : audioData;

        const wavBuffer = pcmToWav(vadAudio, 16000, 1, 16);

        const ai = (this as unknown as { env: { AI: { run: Ai["run"] } } }).env
          .AI;
        const result = (await ai.run(model as Parameters<typeof ai.run>[0], {
          audio: {
            body: toStream(wavBuffer),
            contentType: "application/octet-stream"
          }
        })) as { is_complete?: boolean; probability?: number };

        return {
          isComplete: result.is_complete ?? false,
          probability: result.probability ?? 0
        };
      } catch (error) {
        console.error("[VoiceAgent] VAD error:", error);
        return { isComplete: true, probability: 1 };
      }
    }

    // --- Conversation persistence ---

    saveMessage(role: "user" | "assistant", text: string) {
      this.sql`
        INSERT INTO cf_voice_messages (role, text, timestamp)
        VALUES (${role}, ${text}, ${Date.now()})
      `;
    }

    getConversationHistory(
      limit?: number
    ): Array<{ role: string; content: string }> {
      const historyLimit = limit ?? opt("historyLimit", DEFAULT_HISTORY_LIMIT);
      const rows = this.sql<{ role: string; text: string }>`
        SELECT role, text FROM cf_voice_messages
        ORDER BY id DESC LIMIT ${historyLimit}
      `;
      return rows.reverse().map((row) => ({
        role: row.role,
        content: row.text
      }));
    }

    // --- Convenience methods ---

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

      const audio = await this.#synthesizeWithHooks(text, connections[0]);

      for (const connection of connections) {
        this.#sendJSON(connection, { type: "status", status: "speaking" });
        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, { type: "transcript_end", text });

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
      const rawAudio = await this.synthesize(textToSpeak);
      return this.afterSynthesize(rawAudio, textToSpeak, connection);
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection) {
      const allowed = await this.beforeCallStart(connection);
      if (!allowed) return;

      console.log(`[VoiceAgent] Call started`);
      this.#audioBuffers.set(connection.id, []);
      this.#startKeepalive(connection.id);
      this.#sendJSON(connection, { type: "status", status: "listening" });

      await this.onCallStart(connection);
    }

    #handleEndCall(connection: Connection) {
      console.log(`[VoiceAgent] Call ended`);
      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);
      this.#audioBuffers.delete(connection.id);
      this.#stopKeepalive(connection.id);
      this.#sendJSON(connection, { type: "status", status: "idle" });

      this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection) {
      console.log(`[VoiceAgent] Interrupted by user`);
      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);
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
    }

    async #handleEndOfSpeech(connection: Connection) {
      const chunks = this.#audioBuffers.get(connection.id);
      if (!chunks || chunks.length === 0) return;

      const audioData = concatenateBuffers(chunks);
      this.#audioBuffers.set(connection.id, []);

      const minAudioBytes = opt("minAudioBytes", DEFAULT_MIN_AUDIO_BYTES);
      if (audioData.byteLength < minAudioBytes) {
        this.#sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      const vadStart = Date.now();
      const vadResult = await this.checkEndOfTurn(audioData);
      const vadMs = Date.now() - vadStart;
      const vadThreshold = opt("vadThreshold", DEFAULT_VAD_THRESHOLD);
      const shouldProceed =
        vadResult.isComplete || vadResult.probability > vadThreshold;

      if (!shouldProceed) {
        console.log(
          `[VoiceAgent] VAD: not end-of-turn (prob=${vadResult.probability.toFixed(2)}), continuing`
        );
        const vadWindowSeconds = opt(
          "vadWindowSeconds",
          DEFAULT_VAD_WINDOW_SECONDS
        );
        const maxPushbackBytes = vadWindowSeconds * 16000 * 2;
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
        this.#sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      console.log(
        `[VoiceAgent] VAD: end-of-turn confirmed (prob=${vadResult.probability.toFixed(2)})`
      );

      this.#activePipeline.get(connection.id)?.abort();
      this.#activePipeline.delete(connection.id);

      const abortController = new AbortController();
      this.#activePipeline.set(connection.id, abortController);
      const { signal } = abortController;

      const pipelineStart = Date.now();
      this.#sendJSON(connection, { type: "status", status: "thinking" });

      try {
        const processedAudio = await this.beforeTranscribe(
          audioData,
          connection
        );
        if (!processedAudio || signal.aborted) {
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const sttStart = Date.now();
        const rawTranscript = await this.transcribe(processedAudio);
        const sttMs = Date.now() - sttStart;
        console.log(`[VoiceAgent] STT: ${sttMs}ms → "${rawTranscript}"`);

        if (signal.aborted) return;

        if (!rawTranscript || rawTranscript.trim().length === 0) {
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const userText = await this.afterTranscribe(rawTranscript, connection);
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

      const notifyDrain = () => {
        if (drainNotify) {
          const resolve = drainNotify;
          drainNotify = null;
          resolve();
        }
      };

      const hasStreamingTTS = typeof this.synthesizeStream === "function";

      // NOTE: Theoretical race condition in the wait logic below.
      // See design/voice.md for details.
      const drainPromise = (async () => {
        let i = 0;
        while (true) {
          while (i >= ttsQueue.length) {
            if (streamComplete && i >= ttsQueue.length) return;
            await new Promise<void>((r) => {
              drainNotify = r;
            });
            if (streamComplete && i >= ttsQueue.length) return;
          }

          if (signal.aborted) return;

          for await (const chunk of ttsQueue[i]) {
            if (signal.aborted) return;
            connection.send(chunk);
            if (!firstAudioSentAt) {
              firstAudioSentAt = Date.now();
            }
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
            for await (const chunk of self.synthesizeStream!(text)) {
              const processed = await self.afterSynthesize(
                chunk,
                text,
                connection
              );
              if (processed) yield processed;
            }
          } else {
            const rawAudio = await self.synthesize(text);
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
          if (index >= buffer.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: buffer[index++] };
        }
      };
    }
  };
}
