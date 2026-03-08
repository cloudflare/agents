import type {
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions
} from "@cloudflare/voice";

export interface DeepgramStreamingSTTOptions {
  /** Deepgram API key. */
  apiKey: string;
  /** Deepgram model. @default "nova-3" */
  model?: string;
  /** Language code. @default "en" */
  language?: string;
  /** Enable smart formatting (numbers, dates, etc.). @default true */
  smartFormat?: boolean;
  /** Enable punctuation. @default true */
  punctuate?: boolean;
  /** Enable filler words (um, uh). @default false */
  fillerWords?: boolean;
  /**
   * Encoding of the audio being sent.
   * The voice pipeline sends 16-bit PCM at 16kHz mono.
   * @default "linear16"
   */
  encoding?: string;
  /** Sample rate in Hz. @default 16000 */
  sampleRate?: number;
  /** Number of audio channels. @default 1 */
  channels?: number;
}

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

/**
 * Deepgram streaming speech-to-text provider for the Agents voice pipeline.
 *
 * Creates per-utterance WebSocket sessions to Deepgram's real-time API.
 * Audio is streamed incrementally as it arrives, producing interim and
 * final transcript results in real time.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoice } from "@cloudflare/voice";
 * import { DeepgramStreamingSTT } from "@cloudflare/voice-deepgram";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   streamingStt = new DeepgramStreamingSTT({
 *     apiKey: this.env.DEEPGRAM_API_KEY
 *   });
 *
 *   async onTurn(transcript, context) { ... }
 * }
 * ```
 */
export class DeepgramStreamingSTT implements StreamingSTTProvider {
  #apiKey: string;
  #model: string;
  #language: string;
  #smartFormat: boolean;
  #punctuate: boolean;
  #fillerWords: boolean;
  #encoding: string;
  #sampleRate: number;
  #channels: number;

  constructor(options: DeepgramStreamingSTTOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "nova-3";
    this.#language = options.language ?? "en";
    this.#smartFormat = options.smartFormat ?? true;
    this.#punctuate = options.punctuate ?? true;
    this.#fillerWords = options.fillerWords ?? false;
    this.#encoding = options.encoding ?? "linear16";
    this.#sampleRate = options.sampleRate ?? 16000;
    this.#channels = options.channels ?? 1;
  }

  createSession(options?: StreamingSTTSessionOptions): StreamingSTTSession {
    const params = new URLSearchParams({
      model: this.#model,
      language: options?.language ?? this.#language,
      encoding: this.#encoding,
      sample_rate: String(this.#sampleRate),
      channels: String(this.#channels),
      interim_results: "true",
      punctuate: String(this.#punctuate),
      smart_format: String(this.#smartFormat),
      filler_words: String(this.#fillerWords),
      // endpointing disabled — we control turn boundaries ourselves
      endpointing: "false"
    });

    const url = `${DEEPGRAM_WS_URL}?${params}`;
    return new DeepgramStreamingSTTSession(url, this.#apiKey, options);
  }
}

/**
 * A single streaming STT session backed by a Deepgram WebSocket connection.
 *
 * Lifecycle: created at start-of-speech, receives audio via feed(),
 * flushed via finish() at end-of-speech, or aborted on interrupt.
 */
class DeepgramStreamingSTTSession implements StreamingSTTSession {
  #onInterim: ((text: string) => void) | undefined;
  #onFinal: ((text: string) => void) | undefined;

  #ws: WebSocket | null = null;
  #connected = false;
  #aborted = false;

  // Audio chunks queued before the WebSocket is open
  #pendingChunks: ArrayBuffer[] = [];

  // Accumulates finalized transcript segments from Deepgram
  #finalizedSegments: string[] = [];

  // Resolves when Deepgram sends the final close-acknowledgement
  // after we send CloseStream, or when we see the last is_final.
  #finishResolve: ((transcript: string) => void) | null = null;
  #finishPromise: Promise<string> | null = null;

  // Whether finish() has been called
  #finishing = false;

  constructor(
    url: string,
    apiKey: string,
    options?: StreamingSTTSessionOptions
  ) {
    this.#onInterim = options?.onInterim;
    this.#onFinal = options?.onFinal;

    if (options?.signal?.aborted) {
      this.#aborted = true;
      return;
    }

    options?.signal?.addEventListener(
      "abort",
      () => {
        this.abort();
      },
      { once: true }
    );

    this.#connect(url, apiKey);
  }

  async #connect(url: string, apiKey: string): Promise<void> {
    try {
      // Workers outbound WebSocket — use fetch with Upgrade header
      const resp = await fetch(url, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Token ${apiKey}`
        }
      });

      if (this.#aborted) {
        // Aborted while connecting
        const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
        if (ws) {
          ws.accept();
          ws.close();
        }
        return;
      }

      const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        console.error("[DeepgramSTT] Failed to establish WebSocket connection");
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
        this.#connected = false;
        this.#resolveFinish();
      });

      ws.addEventListener("error", (event: Event) => {
        console.error("[DeepgramSTT] WebSocket error:", event);
        this.#connected = false;
        this.#resolveFinish();
      });

      // Flush any audio chunks that arrived before the WS was open
      for (const chunk of this.#pendingChunks) {
        ws.send(chunk);
      }
      this.#pendingChunks = [];

      // If finish() was called while we were connecting, close now
      if (this.#finishing) {
        this.#sendCloseStream();
      }
    } catch (err) {
      console.error("[DeepgramSTT] Connection error:", err);
      this.#resolveFinish();
    }
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#aborted || this.#finishing) return;

    if (this.#connected && this.#ws) {
      this.#ws.send(chunk);
    } else {
      // Queue until connected
      this.#pendingChunks.push(chunk);
    }
  }

  async finish(): Promise<string> {
    if (this.#aborted) return "";

    this.#finishing = true;

    // Create the promise that will resolve when Deepgram closes
    if (!this.#finishPromise) {
      this.#finishPromise = new Promise<string>((resolve) => {
        this.#finishResolve = resolve;
      });
    }

    if (this.#connected && this.#ws) {
      this.#sendCloseStream();
    }
    // else: #connect() will call #sendCloseStream() when it opens

    return this.#finishPromise;
  }

  abort(): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#pendingChunks = [];

    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // ignore close errors
      }
      this.#ws = null;
    }

    this.#resolveFinish();
  }

  #sendCloseStream(): void {
    if (this.#ws && this.#connected) {
      try {
        this.#ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        // Connection may have dropped
        this.#resolveFinish();
      }
    }
  }

  #resolveFinish(): void {
    if (this.#finishResolve) {
      const transcript = this.#finalizedSegments.join(" ").trim();
      this.#finishResolve(transcript);
      this.#finishResolve = null;
    }
  }

  #handleMessage(event: MessageEvent): void {
    if (this.#aborted) return;

    try {
      const data =
        typeof event.data === "string" ? JSON.parse(event.data) : null;

      if (!data) return;

      // Deepgram response schema
      if (data.type === "Results") {
        const alt = data.channel?.alternatives?.[0];
        if (!alt) return;

        const transcript: string = alt.transcript ?? "";

        if (data.is_final) {
          // Finalized segment — stable, will not change
          if (transcript) {
            this.#finalizedSegments.push(transcript);
            this.#onFinal?.(transcript);
          }
        } else {
          // Interim result — unstable, may change
          if (transcript) {
            this.#onInterim?.(transcript);
          }
        }
      }

      // Metadata message (connection opened) — ignore
      // Error messages
      if (data.type === "Error") {
        console.error(
          `[DeepgramSTT] Error: ${data.description ?? data.message ?? JSON.stringify(data)}`
        );
      }
    } catch {
      // Ignore non-JSON or malformed messages
    }
  }
}
