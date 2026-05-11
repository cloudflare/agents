/**
 * Workers AI provider implementations for the voice pipeline.
 *
 * These are convenience classes that wrap the Workers AI binding
 * (env.AI) for STT and TTS. They are not required — any object
 * satisfying the provider interfaces works.
 */

import type {
  TTSProvider,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "./types";

// --- Loose AI binding type ---

/** Loose type for the Workers AI binding — avoids hard dependency on @cloudflare/workers-types. */
interface AiLike {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
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

// --- Flux continuous STT ---

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
 * Workers AI continuous speech-to-text provider using the Flux model.
 *
 * Flux is a conversational STT model with built-in end-of-turn detection.
 * A single session is created per call and receives all audio continuously.
 * The model detects speech boundaries and fires `onUtterance` when a
 * turn is complete — no client-side silence detection needed for STT.
 *
 * Recommended for `withVoice` (conversational voice agents).
 *
 * @example
 * ```ts
 * import { Agent } from "agents";
 * import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * class MyAgent extends VoiceAgent<Env> {
 *   transcriber = new WorkersAIFluxSTT(this.env.AI);
 *   tts = new WorkersAITTS(this.env.AI);
 *
 *   async onTurn(transcript, context) { ... }
 * }
 * ```
 */
export class WorkersAIFluxSTT implements Transcriber {
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

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new FluxSession(
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
 * Per-call Flux transcription session. Lives for the entire call.
 *
 * Handles multi-turn conversations: on EndOfTurn, fires onUtterance
 * and resets transcript state for the next turn. On StartOfTurn,
 * clears accumulated text. The session stays alive across turns
 * and is only closed on end_call or disconnect.
 */
class FluxSession implements TranscriberSession {
  #onInterim: ((text: string) => void) | undefined;
  #onSpeechStart: ((text?: string) => void) | undefined;
  #onUtterance: ((text: string) => void) | undefined;

  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;

  #pendingChunks: ArrayBuffer[] = [];
  #currentTranscript = "";

  constructor(
    ai: AiLike,
    config: FluxSessionConfig,
    options?: TranscriberSessionOptions
  ) {
    this.#onInterim = options?.onInterim;
    this.#onSpeechStart = options?.onSpeechStart;
    this.#onUtterance = options?.onUtterance;
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

      if (this.#closed) {
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
        return;
      }

      ws.accept();
      this.#ws = ws;
      this.#connected = true;

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event);
      });

      ws.addEventListener("close", () => {
        this.#connected = false;
      });

      ws.addEventListener("error", (event: Event) => {
        console.error("[FluxSTT] WebSocket error:", event);
        this.#connected = false;
      });

      for (const chunk of this.#pendingChunks) {
        ws.send(chunk);
      }
      this.#pendingChunks = [];
    } catch (err) {
      console.error("[FluxSTT] Connection error:", err);
    }
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;

    if (this.#connected && this.#ws) {
      this.#ws.send(chunk);
    } else {
      this.#pendingChunks.push(chunk);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingChunks = [];
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

  #handleMessage(event: MessageEvent): void {
    if (this.#closed) return;

    try {
      const data: FluxEvent =
        typeof event.data === "string" ? JSON.parse(event.data) : null;

      if (!data || !data.event) return;

      const transcript = data.transcript ?? "";

      switch (data.event) {
        case "StartOfTurn":
          this.#currentTranscript = "";
          this.#onSpeechStart?.(transcript || undefined);
          if (transcript) {
            this.#currentTranscript = transcript;
            this.#onInterim?.(transcript);
          }
          break;

        case "Update":
          if (transcript) {
            this.#currentTranscript = transcript;
            this.#onInterim?.(transcript);
          }
          break;

        case "EndOfTurn": {
          const finalTranscript = transcript || this.#currentTranscript;
          this.#currentTranscript = "";
          if (finalTranscript) {
            this.#onUtterance?.(finalTranscript);
          }
          break;
        }

        case "EagerEndOfTurn":
          if (transcript) {
            this.#currentTranscript = transcript;
            this.#onInterim?.(transcript);
          }
          break;

        case "TurnResumed":
          this.#currentTranscript = transcript;
          if (transcript) {
            this.#onInterim?.(transcript);
          }
          break;
      }
    } catch {
      // Ignore non-JSON or malformed messages
    }
  }
}

// --- Nova 3 continuous STT ---

export interface WorkersAINova3STTOptions {
  /** Language code. @default "en" */
  language?: string;
  /** Endpointing silence duration in ms. @default 300 */
  endpointingMs?: number;
  /** Utterance end detection timeout in ms. @default 1000 */
  utteranceEndMs?: number;
  /** Enable smart formatting (numbers, dates, etc.). @default true */
  smartFormat?: boolean;
  /** Enable punctuation. @default true */
  punctuate?: boolean;
  /** Keyterms to boost recognition of specialized terminology. */
  keyterms?: string[];
  /** Sample rate in Hz. @default 16000 */
  sampleRate?: number;
}

/**
 * Workers AI continuous speech-to-text provider using Nova 3.
 *
 * Nova 3 is a high-accuracy STT model with streaming WebSocket support.
 * A single session is created per call and receives all audio continuously.
 * Server-side VAD events and endpointing handle speech boundary detection.
 *
 * Recommended for `withVoiceInput` (dictation / voice input UIs).
 *
 * @example
 * ```ts
 * import { Agent } from "agents";
 * import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
 *
 * const InputAgent = withVoiceInput(Agent);
 *
 * class MyAgent extends InputAgent<Env> {
 *   transcriber = new WorkersAINova3STT(this.env.AI);
 *
 *   onTranscript(text, connection) { ... }
 * }
 * ```
 */
export class WorkersAINova3STT implements Transcriber {
  #ai: AiLike;
  #sampleRate: number;
  #language: string;
  #endpointingMs: number;
  #utteranceEndMs: number;
  #smartFormat: boolean;
  #punctuate: boolean;
  #keyterms: string[] | undefined;

  constructor(ai: AiLike, options?: WorkersAINova3STTOptions) {
    this.#ai = ai;
    this.#sampleRate = options?.sampleRate ?? 16000;
    this.#language = options?.language ?? "en";
    this.#endpointingMs = options?.endpointingMs ?? 300;
    this.#utteranceEndMs = options?.utteranceEndMs ?? 1000;
    this.#smartFormat = options?.smartFormat ?? true;
    this.#punctuate = options?.punctuate ?? true;
    this.#keyterms = options?.keyterms;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new Nova3Session(
      this.#ai,
      {
        sampleRate: this.#sampleRate,
        language: this.#language,
        endpointingMs: this.#endpointingMs,
        utteranceEndMs: this.#utteranceEndMs,
        smartFormat: this.#smartFormat,
        punctuate: this.#punctuate,
        keyterms: this.#keyterms
      },
      options
    );
  }
}

interface Nova3SessionConfig {
  sampleRate: number;
  language: string;
  endpointingMs: number;
  utteranceEndMs: number;
  smartFormat: boolean;
  punctuate: boolean;
  keyterms?: string[];
}

interface Nova3Result {
  type: string;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
}

/**
 * Per-call Nova 3 transcription session. Lives for the entire call.
 *
 * Uses Nova 3's endpointing and VAD events to detect utterance
 * boundaries. When a result arrives with `speech_final: true`,
 * the accumulated finalized segments are emitted as an utterance.
 */
class Nova3Session implements TranscriberSession {
  #onInterim: ((text: string) => void) | undefined;
  #onUtterance: ((text: string) => void) | undefined;

  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;

  #pendingChunks: ArrayBuffer[] = [];

  #finalizedSegments: string[] = [];

  constructor(
    ai: AiLike,
    config: Nova3SessionConfig,
    options?: TranscriberSessionOptions
  ) {
    this.#onInterim = options?.onInterim;
    this.#onUtterance = options?.onUtterance;
    this.#connect(ai, config);
  }

  async #connect(ai: AiLike, config: Nova3SessionConfig): Promise<void> {
    try {
      const input: Record<string, unknown> = {
        encoding: "linear16",
        sample_rate: String(config.sampleRate),
        language: config.language,
        interim_results: "true",
        vad_events: "true",
        endpointing: String(config.endpointingMs),
        utterance_end_ms: String(config.utteranceEndMs),
        smart_format: String(config.smartFormat),
        punctuate: String(config.punctuate)
      };
      if (config.keyterms?.length) input.keyterm = config.keyterms[0];

      const resp = await ai.run("@cf/deepgram/nova-3", input, {
        websocket: true
      });

      if (this.#closed) {
        const ws = (resp as { webSocket?: WebSocket }).webSocket;
        if (ws) {
          ws.accept();
          ws.close();
        }
        return;
      }

      const ws = (resp as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        console.error("[Nova3STT] Failed to establish WebSocket connection");
        return;
      }

      ws.accept();
      this.#ws = ws;
      this.#connected = true;

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event);
      });

      ws.addEventListener("close", () => {
        this.#connected = false;
      });

      ws.addEventListener("error", (event: Event) => {
        console.error("[Nova3STT] WebSocket error:", event);
        this.#connected = false;
      });

      for (const chunk of this.#pendingChunks) {
        ws.send(chunk);
      }
      this.#pendingChunks = [];
    } catch (err) {
      console.error("[Nova3STT] Connection error:", err);
    }
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;

    if (this.#connected && this.#ws) {
      this.#ws.send(chunk);
    } else {
      this.#pendingChunks.push(chunk);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingChunks = [];
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

  #handleMessage(event: MessageEvent): void {
    if (this.#closed) return;

    try {
      const data: Nova3Result =
        typeof event.data === "string" ? JSON.parse(event.data) : null;

      if (!data) return;

      if (data.type === "Results") {
        // Defensive re-init: stale messages after abnormal teardown can observe
        // this field as undefined in some runtime edge cases. Keep normal
        // behavior unchanged while avoiding throws on late Results events.
        if (!this.#finalizedSegments) this.#finalizedSegments = [];

        const transcript = data.channel?.alternatives?.[0]?.transcript ?? "";

        if (data.is_final && transcript) {
          this.#finalizedSegments.push(transcript);
        }

        if (data.speech_final) {
          const fullTranscript = (this.#finalizedSegments ?? [])
            .join(" ")
            .trim();
          this.#finalizedSegments = [];
          if (fullTranscript) {
            this.#onUtterance?.(fullTranscript);
          }
        } else if (!data.is_final && transcript) {
          const finalizedSegments = this.#finalizedSegments ?? [];
          const display =
            finalizedSegments.length > 0
              ? finalizedSegments.join(" ") + " " + transcript
              : transcript;
          this.#onInterim?.(display);
        }
      }
    } catch {
      // Ignore non-JSON or malformed messages
    }
  }
}
