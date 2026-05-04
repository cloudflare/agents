/**
 * Telnyx STT provider for the Cloudflare Agents SDK.
 *
 * Implements the Transcriber interface from @cloudflare/voice,
 * streaming audio to the Telnyx WebSocket STT API.
 */

import type { Transcriber, TranscriberSession } from "@cloudflare/voice";
import { TelnyxClient, type TelnyxClientConfig } from "../client.js";

const DEFAULT_STT_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";

/**
 * Build a 44-byte WAV header for streaming PCM16 audio.
 * The data-size field is set to 0x7FFFFFFF since the total length is unknown.
 */
function wavHeader(sampleRate: number, channels: number): ArrayBuffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);

  // RIFF header
  v.setUint32(0, 0x52494646); // "RIFF"
  v.setUint32(4, 0x7fffffff, true); // file size (unknown, max)
  v.setUint32(8, 0x57415645); // "WAVE"

  // fmt chunk
  v.setUint32(12, 0x666d7420); // "fmt "
  v.setUint32(16, 16, true); // chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);

  // data chunk
  v.setUint32(36, 0x64617461); // "data"
  v.setUint32(40, 0x7fffffff, true); // data size (unknown, max)

  return buf;
}

export interface TelnyxSTTConfig extends TelnyxClientConfig {
  /** STT engine (default: "Telnyx") */
  engine?: string;
  /** Language code for transcription (default: "en") */
  language?: string;
  /**
   * Audio input format sent to the Telnyx API.
   * @default "wav"
   *
   * The Cloudflare voice pipeline delivers raw PCM16 chunks. The Telnyx STT
   * API does not accept raw PCM — it requires a container format. When set to
   * "wav" (the default), the session automatically prepends a WAV header so
   * the raw PCM stream is valid.
   */
  inputFormat?: string;
  /** Deepgram model when engine is "Deepgram" (e.g., "nova-3", "flux") */
  transcriptionModel?: string;
  /** Enable interim results (default: true) */
  interimResults?: boolean;
  /**
   * Override the WebSocket URL for the STT streaming endpoint.
   * @default "wss://api.telnyx.com/v2/speech-to-text/transcription"
   */
  sttWsUrl?: string;
}

export interface TelnyxSTTSessionOptions {
  language?: string;
  onInterim?: (text: string) => void;
  onUtterance?: (transcript: string) => void;
}

export class TelnyxSTT implements Transcriber {
  private client: TelnyxClient;
  private engine: string;
  private language: string;
  private inputFormat: string;
  private transcriptionModel?: string;
  private interimResults: boolean;
  private sttUrl: string;

  constructor(config: TelnyxSTTConfig) {
    this.client = new TelnyxClient(config);
    this.engine = config.engine ?? "Telnyx";
    this.language = config.language ?? "en";
    this.inputFormat = config.inputFormat ?? "wav";
    this.transcriptionModel = config.transcriptionModel;
    this.interimResults = config.interimResults ?? true;
    this.sttUrl = config.sttWsUrl ?? DEFAULT_STT_URL;
  }

  createSession(options?: TelnyxSTTSessionOptions): TelnyxSTTSession {
    const language = options?.language ?? this.language;
    return new TelnyxSTTSession({
      apiKey: this.client.apiKey,
      sttUrl: this.sttUrl,
      engine: this.engine,
      inputFormat: this.inputFormat,
      transcriptionModel: this.transcriptionModel,
      interimResults: this.interimResults,
      language,
      onInterim: options?.onInterim,
      onUtterance: options?.onUtterance
    });
  }
}

interface SessionParams {
  apiKey: string;
  sttUrl: string;
  engine: string;
  inputFormat: string;
  transcriptionModel?: string;
  interimResults: boolean;
  language: string;
  onInterim?: (text: string) => void;
  onUtterance?: (transcript: string) => void;
}

export class TelnyxSTTSession implements TranscriberSession {
  private ws: WebSocket | null = null;
  private pendingChunks: ArrayBuffer[] = [];
  private closed = false;
  private sentWavHeader = false;
  private inputFormat: string;
  private onInterim?: (text: string) => void;
  private onUtterance?: (transcript: string) => void;

  constructor(params: SessionParams) {
    this.onInterim = params.onInterim;
    this.onUtterance = params.onUtterance;
    this.inputFormat = params.inputFormat;

    const url = new URL(params.sttUrl);
    url.searchParams.set("transcription_engine", params.engine);
    url.searchParams.set("input_format", params.inputFormat);
    url.searchParams.set("language", params.language);
    url.searchParams.set("interim_results", String(params.interimResults));
    if (params.transcriptionModel) {
      url.searchParams.set("transcription_model", params.transcriptionModel);
    }
    url.searchParams.set("token", params.apiKey);

    this.connect(url.toString(), params.apiKey);
  }

  private async connect(wsUrl: string, apiKey: string): Promise<void> {
    try {
      // Use the Cloudflare Workers fetch-upgrade pattern.
      const resp = await fetch(wsUrl.replace("wss://", "https://"), {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${apiKey}`
        }
      });

      const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        throw new Error(
          "STT WebSocket requires the Cloudflare Workers runtime. " +
            "The fetch-upgrade did not return a WebSocket pair."
        );
      }

      // Register listeners BEFORE accepting the connection to avoid
      // a race where frames arrive between accept() and addEventListener().
      ws.addEventListener("message", (event: MessageEvent) => {
        this.handleMessage(event);
      });

      ws.addEventListener("error", (event: Event) => {
        console.error("[TelnyxSTT] WebSocket error:", event);
        this.closed = true;
      });

      ws.addEventListener("close", () => {
        this.closed = true;
      });

      // Now accept — listeners are already in place.
      (ws as unknown as { accept: () => void }).accept();

      if (this.closed) return;

      this.ws = ws;

      // When using wav format, send the WAV header before any PCM data
      // so the API knows the sample rate, bit depth, and channel count.
      if (this.inputFormat === "wav" && !this.sentWavHeader) {
        ws.send(wavHeader(16_000, 1));
        this.sentWavHeader = true;
      }

      // Flush any chunks buffered while the connection was being established.
      for (const chunk of this.pendingChunks) {
        ws.send(chunk);
      }
      this.pendingChunks = [];
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Cloudflare Workers")
      ) {
        console.error(`[TelnyxSTT] ${error.message}`);
      } else {
        console.error("[TelnyxSTT] WebSocket connection failed:", error);
      }
      this.closed = true;
    }
  }

  feed(chunk: ArrayBuffer): void {
    if (this.closed) return;

    if (this.ws) {
      this.ws.send(chunk);
    } else {
      this.pendingChunks.push(chunk);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingChunks = [];
    this.ws?.close();
  }

  private handleMessage(event: MessageEvent): void {
    if (this.closed) return;
    let data: { transcript?: string; is_final?: boolean };
    try {
      data = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (typeof data.transcript !== "string" || data.transcript === "") return;

    if (data.is_final) {
      this.onUtterance?.(data.transcript);
    } else {
      this.onInterim?.(data.transcript);
    }
  }
}
