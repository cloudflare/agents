/**
 * Workers AI provider implementations for the voice pipeline.
 *
 * These are convenience classes that wrap the Workers AI binding
 * (env.AI) for STT, TTS, and VAD. They are not required — any
 * object satisfying the provider interfaces works.
 */

import type {
  STTProvider,
  TTSProvider,
  VADProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions
} from "./types";

// --- Audio utilities ---

function toStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    }
  });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Convert raw PCM audio to WAV format. Exported for custom providers. */
export function pcmToWav(
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

// --- Loose AI binding type ---

/** Loose type for the Workers AI binding — avoids hard dependency on @cloudflare/workers-types. */
interface AiLike {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

// --- STT ---

export interface WorkersAISTTOptions {
  /** STT model name. @default "@cf/deepgram/nova-3" */
  model?: string;
  /** Language code (e.g. "en", "es", "fr"). @default "en" */
  language?: string;
}

/**
 * Workers AI speech-to-text provider.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   stt = new WorkersAISTT(this.env.AI);
 * }
 * ```
 */
export class WorkersAISTT implements STTProvider {
  #ai: AiLike;
  #model: string;
  #language: string;

  constructor(ai: AiLike, options?: WorkersAISTTOptions) {
    this.#ai = ai;
    this.#model = options?.model ?? "@cf/deepgram/nova-3";
    this.#language = options?.language ?? "en";
  }

  async transcribe(
    audioData: ArrayBuffer,
    signal?: AbortSignal
  ): Promise<string> {
    const wavBuffer = pcmToWav(audioData, 16000, 1, 16);
    const result = (await this.#ai.run(
      this.#model,
      {
        audio: {
          body: toStream(wavBuffer),
          contentType: "audio/wav"
        },
        language: this.#language,
        punctuate: true,
        smart_format: true
      },
      signal ? { signal } : undefined
    )) as {
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
}

// --- TTS ---

export interface WorkersAITTSOptions {
  /** TTS model name. @default "@cf/deepgram/aura-1" */
  model?: string;
  /** TTS speaker voice. @default "asteria" */
  speaker?: string;
}

/**
 * Workers AI text-to-speech provider.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   tts = new WorkersAITTS(this.env.AI);
 * }
 * ```
 */
export class WorkersAITTS implements TTSProvider {
  #ai: AiLike;
  #model: string;
  #speaker: string;

  constructor(ai: AiLike, options?: WorkersAITTSOptions) {
    this.#ai = ai;
    this.#model = options?.model ?? "@cf/deepgram/aura-1";
    this.#speaker = options?.speaker ?? "asteria";
  }

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const response = (await this.#ai.run(
      this.#model,
      { text, speaker: this.#speaker },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;

    return await response.arrayBuffer();
  }
}

// --- Streaming STT (Flux) ---

export interface WorkersAIFluxSTTOptions {
  /** End-of-turn confidence threshold (0.5-0.9). @default 0.7 */
  eotThreshold?: number;
  /**
   * Eager end-of-turn threshold (0.3-0.9). When set, enables
   * EagerEndOfTurn and TurnResumed events for speculative processing.
   */
  eagerEotThreshold?: number;
  /** EOT timeout in milliseconds. @default 5000 */
  eotTimeoutMs?: number;
  /** Keyterms to boost recognition of specialized terminology. */
  keyterms?: string[];
  /** Sample rate in Hz. @default 16000 */
  sampleRate?: number;
}

/**
 * Workers AI streaming speech-to-text provider using the Flux model.
 *
 * Flux is a conversational STT model with built-in end-of-turn detection.
 * It transcribes audio incrementally via a WebSocket connection to the
 * Workers AI binding — no external API key required.
 *
 * When using Flux, the separate VAD provider is optional — Flux detects
 * end-of-turn natively. Client-side silence detection still triggers the
 * pipeline, but the server-side VAD call can be skipped for lower latency.
 *
 * @example
 * ```ts
 * import { Agent } from "agents";
 * import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "agents/experimental/voice";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * class MyAgent extends VoiceAgent<Env> {
 *   streamingStt = new WorkersAIFluxSTT(this.env.AI);
 *   tts = new WorkersAITTS(this.env.AI);
 *   // No VAD needed — Flux handles turn detection
 *
 *   async onTurn(transcript, context) { ... }
 * }
 * ```
 */
export class WorkersAIFluxSTT implements StreamingSTTProvider {
  #ai: AiLike;
  #sampleRate: number;
  #eotThreshold: number | undefined;
  #eagerEotThreshold: number | undefined;
  #eotTimeoutMs: number | undefined;
  #keyterms: string[] | undefined;

  constructor(ai: AiLike, options?: WorkersAIFluxSTTOptions) {
    this.#ai = ai;
    this.#sampleRate = options?.sampleRate ?? 16000;
    this.#eotThreshold = options?.eotThreshold;
    this.#eagerEotThreshold = options?.eagerEotThreshold;
    this.#eotTimeoutMs = options?.eotTimeoutMs;
    this.#keyterms = options?.keyterms;
  }

  createSession(options?: StreamingSTTSessionOptions): StreamingSTTSession {
    return new FluxSTTSession(
      this.#ai,
      {
        sampleRate: this.#sampleRate,
        eotThreshold: this.#eotThreshold,
        eagerEotThreshold: this.#eagerEotThreshold,
        eotTimeoutMs: this.#eotTimeoutMs,
        keyterms: this.#keyterms
      },
      options
    );
  }
}

interface FluxSessionConfig {
  sampleRate: number;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
  keyterms?: string[];
}

interface FluxEvent {
  event:
    | "Update"
    | "StartOfTurn"
    | "EagerEndOfTurn"
    | "TurnResumed"
    | "EndOfTurn";
  transcript?: string;
  end_of_turn_confidence?: number;
}

/**
 * A single streaming STT session backed by a Flux WebSocket via env.AI.
 *
 * Lifecycle: created at start-of-speech, receives audio via feed(),
 * flushed via finish() at end-of-speech, or aborted on interrupt.
 */
class FluxSTTSession implements StreamingSTTSession {
  #onInterim: ((text: string) => void) | undefined;
  #onFinal: ((text: string) => void) | undefined;
  #onEndOfTurn: ((text: string) => void) | undefined;

  #ws: WebSocket | null = null;
  #connected = false;
  #aborted = false;

  // Audio chunks queued before the WebSocket is open
  #pendingChunks: ArrayBuffer[] = [];

  // Latest transcript from Update events (may still change)
  #latestTranscript = "";

  // Transcript from EndOfTurn event (stable)
  #endOfTurnTranscript: string | null = null;

  // finish() state
  #finishing = false;
  #finishResolve: ((transcript: string) => void) | null = null;
  #finishPromise: Promise<string> | null = null;
  #finishTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    ai: AiLike,
    config: FluxSessionConfig,
    options?: StreamingSTTSessionOptions
  ) {
    this.#onInterim = options?.onInterim;
    this.#onFinal = options?.onFinal;
    this.#onEndOfTurn = options?.onEndOfTurn;
    console.log(`[FluxSTT] Creating session with config:`, config);
    this.#connect(ai, config);
  }

  async #connect(ai: AiLike, config: FluxSessionConfig): Promise<void> {
    try {
      const input: Record<string, unknown> = {
        encoding: "linear16",
        sample_rate: String(config.sampleRate)
      };
      if (config.eotThreshold != null)
        input.eot_threshold = String(config.eotThreshold);
      if (config.eagerEotThreshold != null)
        input.eager_eot_threshold = String(config.eagerEotThreshold);
      if (config.eotTimeoutMs != null)
        input.eot_timeout_ms = String(config.eotTimeoutMs);
      if (config.keyterms?.length) input.keyterm = config.keyterms[0];

      const resp = await ai.run("@cf/deepgram/flux", input, {
        websocket: true
      });

      if (this.#aborted) {
        const ws = (resp as { webSocket?: WebSocket }).webSocket;
        if (ws) {
          ws.accept();
          ws.close();
        }
        return;
      }

      const ws = (resp as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        console.error("[FluxSTT] Failed to establish WebSocket connection");
        this.#resolveFinish();
        return;
      }

      ws.accept();
      this.#ws = ws;
      this.#connected = true;

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event);
      });

      ws.addEventListener("close", () => {
        console.log(`[FluxSTT] WebSocket closed`);
        this.#clearFinishTimeout();
        this.#connected = false;
        this.#resolveFinish();
      });

      ws.addEventListener("error", (event: Event) => {
        console.error("[FluxSTT] WebSocket error:", event);
        this.#connected = false;
        this.#resolveFinish();
      });

      // Flush any audio chunks that arrived before the WS was open
      console.log(
        `[FluxSTT] WebSocket connected, flushing ${this.#pendingChunks.length} pending chunks`
      );
      for (const chunk of this.#pendingChunks) {
        ws.send(chunk);
      }
      this.#pendingChunks = [];

      // If finish() was called while we were connecting, start the
      // finish timeout instead of closing immediately. This gives Flux
      // time to process the audio we just flushed.
      if (this.#finishing) {
        this.#startFinishTimeout();
      }
    } catch (err) {
      console.error("[FluxSTT] Connection error:", err);
      this.#resolveFinish();
    }
  }

  #feedCounter = 0;

  feed(chunk: ArrayBuffer): void {
    if (this.#aborted || this.#finishing) return;

    this.#feedCounter++;
    if (this.#feedCounter % 100 === 0) {
      console.log(
        `[FluxSTT] feed #${this.#feedCounter}: ${chunk.byteLength}B, connected=${this.#connected}, pending=${this.#pendingChunks.length}`
      );
    }

    if (this.#connected && this.#ws) {
      this.#ws.send(chunk);
    } else {
      // Queue until connected
      this.#pendingChunks.push(chunk);
    }
  }

  async finish(): Promise<string> {
    console.log(
      `[FluxSTT] finish() called: aborted=${this.#aborted}, endOfTurnTranscript=${this.#endOfTurnTranscript !== null ? `"${this.#endOfTurnTranscript}"` : "null"}, latestTranscript="${this.#latestTranscript}", connected=${this.#connected}`
    );
    if (this.#aborted) return "";

    this.#finishing = true;

    // If we already got an EndOfTurn, return immediately
    if (this.#endOfTurnTranscript !== null) {
      this.#close();
      return this.#endOfTurnTranscript;
    }

    // Create the promise that will resolve when we have the transcript
    if (!this.#finishPromise) {
      this.#finishPromise = new Promise<string>((resolve) => {
        this.#finishResolve = resolve;
      });
    }

    // Don't close the WS immediately — keep it open so Flux can finish
    // processing buffered audio and send EndOfTurn. The timeout is a
    // safety net: if Flux doesn't respond in time, resolve with whatever
    // partial transcript we have.
    if (this.#connected && this.#ws) {
      this.#startFinishTimeout();
    }
    // else: #connect() will start the timeout after flushing

    return this.#finishPromise;
  }

  abort(): void {
    console.log(`[FluxSTT] abort() called, already aborted=${this.#aborted}`);
    if (this.#aborted) return;
    this.#aborted = true;
    this.#clearFinishTimeout();
    this.#pendingChunks = [];
    this.#close();
    this.#resolveFinish();
  }

  #close(): void {
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // ignore close errors
      }
      this.#ws = null;
    }
    this.#connected = false;
  }

  #closeAndResolve(): void {
    this.#clearFinishTimeout();
    this.#close();
    this.#resolveFinish();
  }

  /**
   * Start a timeout that gives Flux time to process remaining audio.
   * If EndOfTurn arrives before the timeout, it resolves immediately
   * (via the EndOfTurn handler). If the WS closes, the close handler
   * resolves. The timeout is the safety net for neither happening.
   */
  #startFinishTimeout(): void {
    if (this.#finishTimeout) return; // already running
    this.#finishTimeout = setTimeout(() => {
      this.#finishTimeout = null;
      console.log(
        `[FluxSTT] finish timeout (3s) — resolving with latestTranscript="${this.#latestTranscript}"`
      );
      this.#close();
      this.#resolveFinish();
    }, 3000);
  }

  #clearFinishTimeout(): void {
    if (this.#finishTimeout) {
      clearTimeout(this.#finishTimeout);
      this.#finishTimeout = null;
    }
  }

  #resolveFinish(): void {
    if (this.#finishResolve) {
      const transcript = this.#endOfTurnTranscript ?? this.#latestTranscript;
      console.log(`[FluxSTT] resolveFinish: "${transcript.trim()}"`);
      this.#finishResolve(transcript.trim());
      this.#finishResolve = null;
    }
  }

  #handleMessage(event: MessageEvent): void {
    if (this.#aborted) return;

    try {
      const data: FluxEvent =
        typeof event.data === "string" ? JSON.parse(event.data) : null;

      if (!data || !data.event) return;

      const transcript = data.transcript ?? "";

      console.log(
        `[FluxSTT] event="${data.event}" transcript="${transcript}" eot_confidence=${data.end_of_turn_confidence ?? "n/a"} finishing=${this.#finishing}`
      );

      switch (data.event) {
        case "Update":
          if (transcript) {
            this.#latestTranscript = transcript;
            this.#onInterim?.(transcript);
          }
          break;

        case "EndOfTurn":
          console.log(`[FluxSTT] EndOfTurn received: "${transcript}"`);
          if (transcript) {
            this.#endOfTurnTranscript = transcript;
            this.#latestTranscript = transcript;
            this.#onFinal?.(transcript);
            this.#onEndOfTurn?.(transcript);
          }
          // If finish() was already called and waiting, resolve now.
          // Clear the timeout — we got a proper EndOfTurn.
          if (this.#finishing) {
            this.#clearFinishTimeout();
            this.#closeAndResolve();
          }
          break;

        case "EagerEndOfTurn":
          console.log(
            `[FluxSTT] EagerEndOfTurn: "${transcript}" confidence=${data.end_of_turn_confidence}`
          );
          // Speculative EOT — transcript is current but may change
          // if TurnResumed fires. Fire onInterim, not onFinal.
          if (transcript) {
            this.#latestTranscript = transcript;
            this.#onInterim?.(transcript);
          }
          break;

        case "TurnResumed":
          console.log(`[FluxSTT] TurnResumed — user continued speaking`);
          // User resumed speaking after EagerEndOfTurn — keep accumulating.
          break;

        case "StartOfTurn":
          console.log(`[FluxSTT] StartOfTurn`);
          // New turn started.
          break;
      }
    } catch {
      // Ignore non-JSON or malformed messages
    }
  }
}

// --- VAD ---

export interface WorkersAIVADOptions {
  /** VAD model name. @default "@cf/pipecat-ai/smart-turn-v2" */
  model?: string;
  /** Audio window in seconds (uses last N seconds of audio). @default 2 */
  windowSeconds?: number;
}

/**
 * Workers AI voice activity detection provider.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   vad = new WorkersAIVAD(this.env.AI);
 * }
 * ```
 */
export class WorkersAIVAD implements VADProvider {
  #ai: AiLike;
  #model: string;
  #windowSeconds: number;

  constructor(ai: AiLike, options?: WorkersAIVADOptions) {
    this.#ai = ai;
    this.#model = options?.model ?? "@cf/pipecat-ai/smart-turn-v2";
    this.#windowSeconds = options?.windowSeconds ?? 2;
  }

  async checkEndOfTurn(
    audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }> {
    const maxBytes = this.#windowSeconds * 16000 * 2;
    const vadAudio =
      audioData.byteLength > maxBytes
        ? audioData.slice(audioData.byteLength - maxBytes)
        : audioData;

    const wavBuffer = pcmToWav(vadAudio, 16000, 1, 16);

    const result = (await this.#ai.run(this.#model, {
      audio: {
        body: toStream(wavBuffer),
        contentType: "application/octet-stream"
      }
    })) as { is_complete?: boolean; probability?: number };

    return {
      isComplete: result.is_complete ?? false,
      probability: result.probability ?? 0
    };
  }
}
