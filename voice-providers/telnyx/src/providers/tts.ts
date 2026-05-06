/**
 * Telnyx TTS provider for the Cloudflare Agents SDK.
 *
 * Implements TTSProvider and StreamingTTSProvider from @cloudflare/voice,
 * with two backend options:
 *
 * - **REST** (default): `POST /v2/text-to-speech/speech` — one HTTP request
 *   per sentence, returns complete mp3 audio. Works with all voices including Ultra.
 *
 * - **WebSocket**: `wss://api.telnyx.com/v2/text-to-speech/speech` — streams
 *   audio chunks as they're synthesized for lower time-to-first-audio.
 *   **Requires the Cloudflare Workers runtime** (uses the fetch-upgrade pattern).
 *   Does NOT support Telnyx Ultra voices.
 *
 * Audio format: MP3 by default — matches the Cloudflare voice pipeline's
 * default `audioFormat: "mp3"` setting. The Telnyx REST API returns MP3
 * regardless of format parameters.
 */

import type { TTSProvider, StreamingTTSProvider } from "@cloudflare/voice";
import { TelnyxClient, type TelnyxClientConfig } from "../client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TelnyxTTSConfig extends TelnyxClientConfig {
  /**
   * Voice identifier.
   * @default "Telnyx.NaturalHD.astra"
   *
   * Examples: `Telnyx.NaturalHD.luna`, `Telnyx.Ultra.<id>`, `Azure.en-US-AvaMultilingualNeural`
   */
  voice?: string;
  /**
   * Backend to use.
   *
   * - `"rest"` (default): HTTP POST per sentence. Works everywhere, all voices.
   * - `"websocket"`: Streams audio chunks for lower time-to-first-audio.
   *   Requires the Cloudflare Workers runtime.
   *
   * @default "rest"
   */
  backend?: "rest" | "websocket";
  /**
   * Override the WebSocket URL for the TTS streaming backend.
   * Only used when `backend` is `"websocket"`.
   * @default "wss://api.telnyx.com/v2/text-to-speech/speech"
   */
  ttsWsUrl?: string;
}

/** Frame received from the Telnyx TTS WebSocket. */
interface TelnyxWSFrame {
  audio?: string | null;
  text?: string | null;
  isFinal?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default voice when none is specified in config. */
const DEFAULT_VOICE = "Telnyx.NaturalHD.astra";
const TTS_PATH = "/text-to-speech/speech";
const DEFAULT_TTS_WS_URL = "wss://api.telnyx.com/v2/text-to-speech/speech";

// ─── Implementation ─────────────────────────────────────────────────────────

export class TelnyxTTS implements TTSProvider, StreamingTTSProvider {
  private client: TelnyxClient;
  private voice: string;
  private backend: "rest" | "websocket";
  private ttsWsUrl: string;

  constructor(config: TelnyxTTSConfig) {
    this.client = new TelnyxClient(config);
    this.voice = config.voice ?? DEFAULT_VOICE;
    this.backend = config.backend ?? "rest";
    this.ttsWsUrl = config.ttsWsUrl ?? DEFAULT_TTS_WS_URL;
  }

  // ─── TTSProvider ───────────────────────────────────────────────────────

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    if (!text?.trim()) return null;

    try {
      if (this.backend === "websocket") {
        return await this.synthesizeViaWS(text, signal);
      }
      return await this.synthesizeViaREST(text, signal);
    } catch (error) {
      if (signal?.aborted) return null;
      console.error("[TelnyxTTS] synthesize error:", error);
      return null;
    }
  }

  // ─── StreamingTTSProvider ──────────────────────────────────────────────

  /**
   * Stream synthesized audio chunks.
   *
   * With the REST backend this yields a single buffered chunk (the complete
   * audio); only the WebSocket backend provides true incremental streaming.
   */
  async *synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer> {
    if (!text?.trim()) return;

    try {
      if (this.backend === "websocket") {
        yield* this.streamViaWS(text, signal);
      } else {
        // REST cannot stream — fetch complete audio then yield as one chunk.
        const audio = await this.synthesizeViaREST(text, signal);
        if (audio) yield audio;
      }
    } catch (error) {
      if (signal?.aborted) return;
      console.error("[TelnyxTTS] synthesizeStream error:", error);
    }
  }

  // ─── REST Backend ──────────────────────────────────────────────────────

  private async synthesizeViaREST(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const response = await fetch(`${this.client.baseUrl}${TTS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.client.apiKey}`
      },
      body: JSON.stringify({
        text,
        voice: this.voice
      }),
      signal
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "unknown");
      console.error(`[TelnyxTTS] REST error: ${response.status} — ${err}`);
      return null;
    }

    return await response.arrayBuffer();
  }

  // ─── WebSocket Backend ─────────────────────────────────────────────────

  private async synthesizeViaWS(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const chunks: ArrayBuffer[] = [];
    for await (const chunk of this.streamViaWS(text, signal)) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) return null;

    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return result.buffer;
  }

  private async *streamViaWS(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer> {
    const url = `${this.ttsWsUrl}?voice=${encodeURIComponent(this.voice)}`;

    let ws: WebSocket;

    try {
      // WebSocket backend requires Cloudflare Workers fetch-upgrade pattern.
      // The Telnyx WS endpoint authenticates via Authorization header, which
      // the standard browser/Node WebSocket API does not support.
      const resp = await fetch(url.replace("wss://", "https://"), {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${this.client.apiKey}`
        }
      });

      const pair = (resp as unknown as { webSocket?: WebSocket }).webSocket;
      if (!pair) {
        throw new Error(
          "WebSocket backend requires the Cloudflare Workers runtime. " +
            "The fetch-upgrade did not return a WebSocket pair. " +
            'Use backend: "rest" outside of Workers.'
        );
      }

      ws = pair;
    } catch (error) {
      // Distinguish between Workers-missing and other failures
      if (
        error instanceof Error &&
        error.message.includes("Cloudflare Workers")
      ) {
        console.error(`[TelnyxTTS] ${error.message}`);
      } else {
        console.error("[TelnyxTTS] WebSocket connection failed:", error);
      }
      return;
    }

    // Register listeners BEFORE accepting the connection to avoid
    // a race where frames arrive between accept() and addEventListener().
    const queue: ArrayBuffer[] = [];
    let done = false;
    let wsError: string | null = null;
    let resolveWait: (() => void) | null = null;

    const waitForData = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (queue.length > 0 || done) resolve();
        else resolveWait = resolve;
      });

    const notify = () => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const frame: TelnyxWSFrame =
          typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (!frame) return;

        if (frame.isFinal) {
          done = true;
          notify();
          return;
        }

        // Only yield streaming chunks (text === null with audio data).
        // Skip the blob frame (text === original text, no audio).
        if (frame.audio && frame.text === null) {
          const binary = base64ToArrayBuffer(frame.audio);
          if (binary.byteLength > 0) {
            queue.push(binary);
            notify();
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.addEventListener("error", () => {
      wsError = "WebSocket error";
      done = true;
      notify();
    });

    ws.addEventListener("close", () => {
      done = true;
      notify();
    });

    // Now accept the connection — listeners are already in place.
    (ws as unknown as { accept: () => void }).accept();

    // Abort handling
    const onAbort = () => {
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    if (signal) {
      if (signal.aborted) {
        try {
          ws.close();
        } catch {
          /* empty */
        }
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      // Telnyx TTS protocol: all three frames are sent back-to-back without
      // waiting for server ACKs. This is the correct protocol — the server
      // begins streaming audio after receiving the stop frame and does not
      // send any acknowledgment for init or content frames.
      // Verified against live API 2026-04-19.
      ws.send(JSON.stringify({ text: " " })); // 1. init
      ws.send(JSON.stringify({ text })); // 2. content
      ws.send(JSON.stringify({ text: "" })); // 3. stop (triggers synthesis)

      while (!signal?.aborted) {
        await waitForData();
        while (queue.length > 0) {
          const chunk = queue.shift()!;
          if (!signal?.aborted) yield chunk;
        }
        if (done) break;
      }

      if (wsError) console.error(`[TelnyxTTS] ${wsError}`);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
