import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "@cloudflare/voice";

export interface DeepgramSTTOptions {
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
  /** Endpointing silence duration in ms. @default 300 */
  endpointingMs?: number;
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
 * Deepgram continuous speech-to-text provider for the Agents voice pipeline.
 *
 * Creates a per-call WebSocket session to Deepgram's real-time API.
 * Audio is streamed continuously with server-side VAD and endpointing
 * handling utterance boundary detection.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoice } from "@cloudflare/voice";
 * import { DeepgramSTT } from "@cloudflare/voice-deepgram";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   transcriber = new DeepgramSTT({
 *     apiKey: this.env.DEEPGRAM_API_KEY
 *   });
 *
 *   async onTurn(transcript, context) { ... }
 * }
 * ```
 */
export class DeepgramSTT implements Transcriber {
  #apiKey: string;
  #model: string;
  #language: string;
  #smartFormat: boolean;
  #punctuate: boolean;
  #fillerWords: boolean;
  #endpointingMs: number;
  #encoding: string;
  #sampleRate: number;
  #channels: number;

  constructor(options: DeepgramSTTOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "nova-3";
    this.#language = options.language ?? "en";
    this.#smartFormat = options.smartFormat ?? true;
    this.#punctuate = options.punctuate ?? true;
    this.#fillerWords = options.fillerWords ?? false;
    this.#endpointingMs = options.endpointingMs ?? 300;
    this.#encoding = options.encoding ?? "linear16";
    this.#sampleRate = options.sampleRate ?? 16000;
    this.#channels = options.channels ?? 1;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
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
      vad_events: "true",
      endpointing: String(this.#endpointingMs)
    });

    const url = `${DEEPGRAM_WS_URL}?${params}`;
    return new DeepgramSession(url, this.#apiKey, options);
  }
}

/**
 * Per-call Deepgram transcription session.
 *
 * Uses Deepgram's endpointing and VAD events for utterance detection.
 * When a result arrives with `speech_final: true`, the accumulated
 * finalized segments are emitted as an utterance.
 */
class DeepgramSession implements TranscriberSession {
  #onInterim: ((text: string) => void) | undefined;
  #onUtterance: ((text: string) => void) | undefined;

  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;

  #pendingChunks: ArrayBuffer[] = [];
  #finalizedSegments: string[] = [];

  constructor(
    url: string,
    apiKey: string,
    options?: TranscriberSessionOptions
  ) {
    this.#onInterim = options?.onInterim;
    this.#onUtterance = options?.onUtterance;
    this.#connect(url, apiKey);
  }

  async #connect(url: string, apiKey: string): Promise<void> {
    try {
      const resp = await fetch(url, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Token ${apiKey}`
        }
      });

      if (this.#closed) {
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
        console.error("[DeepgramSTT] WebSocket error:", event);
        this.#connected = false;
      });

      for (const chunk of this.#pendingChunks) {
        ws.send(chunk);
      }
      this.#pendingChunks = [];
    } catch (err) {
      console.error("[DeepgramSTT] Connection error:", err);
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

    if (this.#ws && this.#connected) {
      try {
        this.#ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        // ignore
      }
    }

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
      const data =
        typeof event.data === "string" ? JSON.parse(event.data) : null;

      if (!data) return;

      if (data.type === "Results") {
        const transcript: string =
          data.channel?.alternatives?.[0]?.transcript ?? "";

        if (data.is_final && transcript) {
          this.#finalizedSegments.push(transcript);
        }

        if (data.speech_final) {
          const fullTranscript = this.#finalizedSegments.join(" ").trim();
          this.#finalizedSegments = [];
          if (fullTranscript) {
            this.#onUtterance?.(fullTranscript);
          }
        } else if (!data.is_final && transcript) {
          const display =
            this.#finalizedSegments.length > 0
              ? this.#finalizedSegments.join(" ") + " " + transcript
              : transcript;
          this.#onInterim?.(display);
        }
      }

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
