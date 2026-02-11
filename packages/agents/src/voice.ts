/**
 * Server-side voice pipeline for the Agents SDK.
 *
 * Provides `VoiceAgent` — a base class that extends `Agent` and handles the
 * full voice pipeline: audio buffering, VAD, STT, streaming TTS, interruption,
 * conversation persistence, and the WebSocket voice protocol.
 *
 * Users extend `VoiceAgent` and implement `onTurn()` with their LLM logic.
 * STT/TTS/VAD default to Workers AI models — override `transcribe()`,
 * `synthesize()`, or `checkEndOfTurn()` for custom providers.
 *
 * @example
 * ```typescript
 * import { VoiceAgent, type VoiceTurnContext } from "agents/voice";
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   async onTurn(transcript: string, context: VoiceTurnContext) {
 *     const result = streamText({ ... });
 *     return result.textStream;
 *   }
 * }
 * ```
 */

import { Agent, type Connection, type WSMessage } from "./";
import { SentenceChunker } from "./sentence-chunker";

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

/** Configuration options for VoiceAgent. Override as a class property. */
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
//
// These interfaces describe the shape of the overridable methods on VoiceAgent.
// Use them when building standalone provider classes (e.g., an ElevenLabs TTS
// provider package) that can be composed with VoiceAgent via delegation:
//
//   class MyAgent extends VoiceAgent<Env> {
//     #tts = new ElevenLabsTTS({ apiKey: "..." });
//     async synthesize(text: string) { return this.#tts.synthesize(text); }
//   }

/** Speech-to-text provider interface. Matches `VoiceAgent.transcribe()`. */
export interface STTProvider {
  transcribe(audio: ArrayBuffer): Promise<string>;
}

/** Text-to-speech provider interface. Matches `VoiceAgent.synthesize()`. */
export interface TTSProvider {
  synthesize(text: string): Promise<ArrayBuffer | null>;
}

/** Voice activity detection provider interface. Matches `VoiceAgent.checkEndOfTurn()`. */
export interface VADProvider {
  checkEndOfTurn(audio: ArrayBuffer): Promise<VADResult>;
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

// --- VoiceAgent ---

/**
 * Base class for building voice agents on Cloudflare Workers.
 *
 * Extends `Agent` and handles the full voice pipeline: audio buffering, VAD,
 * STT, streaming TTS (sentence chunking + concurrent synthesis), interruption,
 * conversation persistence (SQLite), and the WebSocket voice protocol.
 *
 * Subclasses must implement `onTurn()` — everything else has sensible defaults.
 *
 * @example
 * ```typescript
 * class MyAgent extends VoiceAgent<Env> {
 *   async onTurn(transcript: string, context: VoiceTurnContext) {
 *     return "Hello! I heard you say: " + transcript;
 *   }
 * }
 * ```
 */
export class VoiceAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown
> extends Agent<Env, State> {
  /** Override to configure voice pipeline options. */
  voiceOptions: VoiceAgentOptions = {};

  // Per-connection audio buffers (not persisted)
  #audioBuffers = new Map<string, ArrayBuffer[]>();

  // Per-connection pipeline abort controllers
  #activePipeline = new Map<string, AbortController>();

  // --- Resolved options (with defaults) ---

  #opt<K extends keyof VoiceAgentOptions>(
    key: K,
    fallback: NonNullable<VoiceAgentOptions[K]>
  ): NonNullable<VoiceAgentOptions[K]> {
    return (this.voiceOptions[key] ?? fallback) as NonNullable<
      VoiceAgentOptions[K]
    >;
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
    this.#sendJSON(connection, { type: "status", status: "idle" });
  }

  onClose(connection: Connection) {
    console.log(`[VoiceAgent] Disconnected: ${connection.id}`);
    this.#activePipeline.get(connection.id)?.abort();
    this.#activePipeline.delete(connection.id);
    this.#audioBuffers.delete(connection.id);
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
      // Not JSON — pass to user hook
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
      case "text_message":
        this.#handleTextMessage(
          connection,
          (parsed as unknown as { text: string }).text
        );
        break;
      default:
        // Non-voice JSON message — pass to user hook
        this.onNonVoiceMessage(connection, message);
        break;
    }
  }

  // --- User-overridable hooks ---

  /**
   * Called when the user finishes speaking. Implement your LLM logic here.
   *
   * Return a `string` for simple (non-streaming) responses, or an
   * `AsyncIterable<string>` (e.g. from AI SDK's `streamText().textStream`)
   * for streaming responses with sentence-level TTS.
   *
   * @param transcript - The user's transcribed speech.
   * @param context - Connection, conversation history, and abort signal.
   */
  onTurn(
    _transcript: string,
    _context: VoiceTurnContext
  ): Promise<string | AsyncIterable<string>> {
    throw new Error(
      "VoiceAgent subclass must implement onTurn(). Return a string or AsyncIterable<string>."
    );
  }

  /** Called when a call starts (user sends start_call). Use for greetings. */
  onCallStart(_connection: Connection): void | Promise<void> {}

  /** Called when a call ends (user sends end_call). */
  onCallEnd(_connection: Connection): void | Promise<void> {}

  /** Called when the user interrupts agent speech. */
  onInterrupt(_connection: Connection): void | Promise<void> {}

  /** Called for non-voice WebSocket messages (text chat, custom commands). */
  onNonVoiceMessage(
    _connection: Connection,
    _message: WSMessage
  ): void | Promise<void> {}

  // --- Pipeline hooks (optional middleware between stages) ---

  /**
   * Called after VAD passes, before STT. Receives the raw PCM audio.
   * Return modified audio, or `null` to skip this turn entirely.
   *
   * Use cases: custom noise filtering, audio format conversion, recording raw input.
   */
  beforeTranscribe(
    audio: ArrayBuffer,
    _connection: Connection
  ): ArrayBuffer | null | Promise<ArrayBuffer | null> {
    return audio;
  }

  /**
   * Called after STT, before the transcript is sent to `onTurn()`.
   * Return modified transcript, or `null` to skip this turn.
   *
   * Use cases: profanity filtering, translation, normalization, keyword detection.
   */
  afterTranscribe(
    transcript: string,
    _connection: Connection
  ): string | null | Promise<string | null> {
    return transcript;
  }

  /**
   * Called before each sentence is synthesized by TTS.
   * Return modified text, or `null` to skip synthesizing this sentence.
   *
   * Use cases: pronunciation fixes, SSML wrapping, translation, content filtering.
   */
  beforeSynthesize(
    text: string,
    _connection: Connection
  ): string | null | Promise<string | null> {
    return text;
  }

  /**
   * Called after TTS produces audio for a sentence, before it is sent to the client.
   * Return modified audio, or `null` to skip sending this chunk.
   *
   * Use cases: audio recording, volume normalization, watermarking.
   */
  afterSynthesize(
    audio: ArrayBuffer | null,
    _text: string,
    _connection: Connection
  ): ArrayBuffer | null | Promise<ArrayBuffer | null> {
    return audio;
  }

  // --- STT / TTS / VAD (overridable for custom providers) ---

  /**
   * Speech-to-text. Default: Workers AI Deepgram Nova 3.
   * Override for custom STT providers.
   */
  async transcribe(audioData: ArrayBuffer): Promise<string> {
    const wavBuffer = pcmToWav(audioData, 16000, 1, 16);
    const model = this.#opt("sttModel", DEFAULT_STT_MODEL);

    const language = this.#opt("language", DEFAULT_LANGUAGE);

    const ai = (this.env as unknown as { AI: { run: Ai["run"] } }).AI;
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

    return result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }

  /**
   * Text-to-speech. Default: Workers AI Deepgram Aura.
   * Override for custom TTS providers.
   */
  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const model = this.#opt("ttsModel", DEFAULT_TTS_MODEL);
    const speaker = this.#opt("ttsSpeaker", DEFAULT_TTS_SPEAKER);

    try {
      const ai = (this.env as unknown as { AI: { run: Ai["run"] } }).AI;
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

  /**
   * Voice activity detection — confirms end-of-turn.
   * Default: Workers AI Pipecat Smart Turn v2.
   * Override for custom VAD providers.
   */
  async checkEndOfTurn(audioData: ArrayBuffer): Promise<VADResult> {
    const vadWindowSeconds = this.#opt(
      "vadWindowSeconds",
      DEFAULT_VAD_WINDOW_SECONDS
    );
    const model = this.#opt("vadModel", DEFAULT_VAD_MODEL);

    try {
      const maxBytes = vadWindowSeconds * 16000 * 2;
      const vadAudio =
        audioData.byteLength > maxBytes
          ? audioData.slice(audioData.byteLength - maxBytes)
          : audioData;

      const wavBuffer = pcmToWav(vadAudio, 16000, 1, 16);

      const ai = (this.env as unknown as { AI: { run: Ai["run"] } }).AI;
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

  /** Save a message to the conversation history (SQLite). */
  saveMessage(role: "user" | "assistant", text: string) {
    this.sql`
      INSERT INTO cf_voice_messages (role, text, timestamp)
      VALUES (${role}, ${text}, ${Date.now()})
    `;
  }

  /** Load conversation history from SQLite. */
  getConversationHistory(
    limit?: number
  ): Array<{ role: string; content: string }> {
    const historyLimit =
      limit ?? this.#opt("historyLimit", DEFAULT_HISTORY_LIMIT);
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

  /**
   * Speak text to a single connection. Synthesizes TTS (through hooks),
   * sends protocol messages, and saves to conversation history.
   * Use for greetings, reminders, etc.
   */
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

  /**
   * Speak text to all connected clients. Useful for scheduled reminders
   * or proactive agent messages. TTS is synthesized once and sent to all.
   */
  async speakAll(text: string): Promise<void> {
    this.saveMessage("assistant", text);

    const connections = [...this.getConnections()];
    if (connections.length === 0) {
      console.log(`[VoiceAgent] No clients connected — saved to history`);
      return;
    }

    // Synthesize once (using first connection for hooks context)
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

  /** Synthesize text through beforeSynthesize/afterSynthesize hooks. */
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
    console.log(`[VoiceAgent] Call started`);
    this.#audioBuffers.set(connection.id, []);

    this.#sendJSON(connection, { type: "status", status: "listening" });

    // Call user hook (greeting, etc.)
    await this.onCallStart(connection);
  }

  #handleEndCall(connection: Connection) {
    console.log(`[VoiceAgent] Call ended`);
    this.#activePipeline.get(connection.id)?.abort();
    this.#activePipeline.delete(connection.id);
    this.#audioBuffers.delete(connection.id);
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

  /**
   * Handle a text message — bypass STT, go straight to onTurn.
   * If a voice call is active (audio buffers exist), responds with TTS audio.
   * If no call is active, responds with text-only transcript.
   */
  async #handleTextMessage(connection: Connection, text: string) {
    if (!text || text.trim().length === 0) return;

    const userText = text.trim();
    console.log(`[VoiceAgent] Text message: "${userText}"`);

    // Cancel any in-flight pipeline
    this.#activePipeline.get(connection.id)?.abort();
    this.#activePipeline.delete(connection.id);

    const abortController = new AbortController();
    this.#activePipeline.set(connection.id, abortController);
    const { signal } = abortController;

    const pipelineStart = Date.now();
    this.#sendJSON(connection, { type: "status", status: "thinking" });

    // Save user message and send transcript
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

      // Determine if we should produce audio (call is active)
      const isInCall = this.#audioBuffers.has(connection.id);

      if (isInCall) {
        // In a call — respond with TTS audio (same as voice pipeline)
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
        // Not in a call — respond with text only (no TTS)
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
          // Stream text tokens without TTS
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
        message: error instanceof Error ? error.message : "Text pipeline failed"
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
  }

  async #handleEndOfSpeech(connection: Connection) {
    const chunks = this.#audioBuffers.get(connection.id);
    if (!chunks || chunks.length === 0) return;

    const audioData = concatenateBuffers(chunks);
    this.#audioBuffers.set(connection.id, []);

    const minAudioBytes = this.#opt("minAudioBytes", DEFAULT_MIN_AUDIO_BYTES);
    if (audioData.byteLength < minAudioBytes) {
      this.#sendJSON(connection, { type: "status", status: "listening" });
      return;
    }

    // Server-side VAD gate
    const vadStart = Date.now();
    const vadResult = await this.checkEndOfTurn(audioData);
    const vadMs = Date.now() - vadStart;
    const vadThreshold = this.#opt("vadThreshold", DEFAULT_VAD_THRESHOLD);
    const shouldProceed =
      vadResult.isComplete || vadResult.probability > vadThreshold;

    if (!shouldProceed) {
      console.log(
        `[VoiceAgent] VAD: not end-of-turn (prob=${vadResult.probability.toFixed(2)}), continuing`
      );
      const buffer = this.#audioBuffers.get(connection.id);
      if (buffer) {
        buffer.unshift(audioData);
      } else {
        this.#audioBuffers.set(connection.id, [audioData]);
      }
      this.#sendJSON(connection, { type: "status", status: "listening" });
      return;
    }

    console.log(
      `[VoiceAgent] VAD: end-of-turn confirmed (prob=${vadResult.probability.toFixed(2)})`
    );

    // Cancel any in-flight pipeline
    this.#activePipeline.get(connection.id)?.abort();
    this.#activePipeline.delete(connection.id);

    const abortController = new AbortController();
    this.#activePipeline.set(connection.id, abortController);
    const { signal } = abortController;

    const pipelineStart = Date.now();
    this.#sendJSON(connection, { type: "status", status: "thinking" });

    try {
      // 1. Pre-STT hook
      const processedAudio = await this.beforeTranscribe(audioData, connection);
      if (!processedAudio || signal.aborted) {
        this.#sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      // 2. Speech-to-text
      const sttStart = Date.now();
      const rawTranscript = await this.transcribe(processedAudio);
      const sttMs = Date.now() - sttStart;
      console.log(`[VoiceAgent] STT: ${sttMs}ms → "${rawTranscript}"`);

      if (signal.aborted) return;

      if (!rawTranscript || rawTranscript.trim().length === 0) {
        this.#sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      // 3. Post-STT hook
      const userText = await this.afterTranscribe(rawTranscript, connection);
      if (!userText || signal.aborted) {
        this.#sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      // Save user message and send transcript
      this.saveMessage("user", userText);
      this.#sendJSON(connection, {
        type: "transcript",
        role: "user",
        text: userText
      });

      // 4. Call onTurn and pipe through streaming TTS
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

  /**
   * Handles both string and AsyncIterable<string> responses from onTurn.
   * For strings: synthesizes the whole thing.
   * For streams: sentence-chunks tokens and synthesizes concurrently.
   */
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
    // Simple string response — no streaming needed
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

    // Streaming response — sentence chunk + concurrent TTS
    return this.#streamingTTSPipeline(
      connection,
      response,
      llmStart,
      pipelineStart,
      signal
    );
  }

  /**
   * Streaming TTS pipeline: tokens → SentenceChunker → concurrent TTS → audio.
   *
   * Timeline:
   *   LLM:   [--tok--tok--SENT1--tok--tok--SENT2--tok--DONE]
   *   TTS:            [----TTS(S1)----]  [----TTS(S2)----] [--TTS(flush)--]
   *   Audio:                          [send S1]          [send S2]       [send flush]
   */
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
    const ttsQueue: Promise<ArrayBuffer | null>[] = [];
    let fullText = "";
    let firstAudioSentAt: number | null = null;
    let lastTtsDoneAt = Date.now();

    let streamComplete = false;
    let drainNotify: (() => void) | null = null;

    const notifyDrain = () => {
      if (drainNotify) {
        const resolve = drainNotify;
        drainNotify = null;
        resolve();
      }
    };

    // Concurrent drain loop — sends TTS audio to client in order
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

        const audio = await ttsQueue[i];
        lastTtsDoneAt = Date.now();

        if (audio && !signal.aborted) {
          connection.send(audio);
          if (!firstAudioSentAt) {
            firstAudioSentAt = Date.now();
          }
        }
        i++;
      }
    })();

    const enqueueSentence = (sentence: string) => {
      ttsQueue.push(
        (async () => {
          const text = await this.beforeSynthesize(sentence, connection);
          if (!text) return null;
          const rawAudio = await this.synthesize(text);
          return this.afterSynthesize(rawAudio, text, connection);
        })()
      );
      notifyDrain();
    };

    this.#sendJSON(connection, {
      type: "transcript_start",
      role: "assistant"
    });

    // Consume token stream
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

    // Flush remaining text
    const remaining = chunker.flush();
    for (const sentence of remaining) {
      enqueueSentence(sentence);
    }

    // Signal drain loop and send final transcript
    streamComplete = true;
    notifyDrain();
    this.#sendJSON(connection, { type: "transcript_end", text: fullText });

    // Wait for all audio to be sent
    await drainPromise;

    const ttsMs = lastTtsDoneAt - llmStart;
    const firstAudioMs = firstAudioSentAt
      ? firstAudioSentAt - pipelineStart
      : 0;

    return { text: fullText, llmMs, ttsMs, firstAudioMs };
  }

  // --- Internal: protocol helpers ---

  #sendJSON(connection: Connection, data: unknown) {
    connection.send(JSON.stringify(data));
  }
}
