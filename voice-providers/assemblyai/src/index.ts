/**
 * @cloudflare/voice-assemblyai — AssemblyAI Universal-3 Pro Streaming STT
 * provider for the Cloudflare Agents voice pipeline.
 *
 * See companion design spec at
 * docs/superpowers/specs/2026-05-27-assemblyai-voice-provider-design.md
 * and implementation plan at
 * docs/superpowers/plans/2026-05-27-assemblyai-voice-provider.md.
 */

import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "@cloudflare/voice";

export interface AssemblyAISTTOptions {
  /** AssemblyAI API key. Sent as the `Authorization` header (raw key, no prefix). */
  apiKey: string;
  /**
   * Domain specialization → `domain=<value>`. `"medical-v1"` enables Medical
   * Mode (en/es/de/fr); the union keeps autocomplete for the known value while
   * accepting any string for forward-compat.
   */
  domain?: "medical-v1" | (string & {});
  /** Domain vocabulary to bias recognition → `keyterms_prompt` (JSON-encoded). */
  keyterms?: string[];
  /**
   * Custom transcription prompt → `prompt`, set at connection time. **Omit to
   * use AssemblyAI's optimized default prompt (recommended — 88% turn-detection
   * accuracy).** If set, build off the default; prompts that reduce punctuation
   * degrade the punctuation-based turn detection.
   */
  prompt?: string;
  /** Min silence (ms) before EOT check → `min_turn_silence`. Server default 100. */
  minTurnSilence?: number;
  /** Max silence (ms) before forced EOT → `max_turn_silence`. Server default 1000. */
  maxTurnSilence?: number;
  /** First-partial timing 0–1000 ms → `interruption_delay`. Server default 500. */
  interruptionDelay?: number;
  /** VAD silence-confidence threshold 0–1 → `vad_threshold`. Raise in noisy environments. */
  vadThreshold?: number;
  /** Steady ~3 s partials during long uninterrupted turns → `continuous_partials`. */
  continuousPartials?: boolean;
  /**
   * Return language metadata on Turn events → `language_detection`. u3-rt-pro
   * transcribes multilingual audio regardless; this only toggles the metadata.
   * Surface it via `onLanguageDetected`.
   */
  languageDetection?: boolean;
  /**
   * Called when a Turn carries detected-language metadata. Provider-specific
   * extension, since the pipeline's text-only `onUtterance`/`onInterim` callbacks
   * cannot carry this.
   */
  onLanguageDetected?: (
    languageCode: string,
    languageConfidence: number
  ) => void;
  /**
   * Full WebSocket base URL override (e.g. EU host or Cloudflare AI Gateway URL).
   * @default "wss://streaming.assemblyai.com/v3/ws"
   */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";

/**
 * Build the AssemblyAI Streaming v3 WebSocket URL from provider options.
 * Underscore-prefixed: internal helper, exported only for unit tests.
 */
export function _buildConnectionUrl(opts: AssemblyAISTTOptions): string {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    speech_model: "u3-rt-pro",
    sample_rate: "16000",
    encoding: "pcm_s16le"
  });

  if (opts.domain !== undefined) params.set("domain", opts.domain);
  if (opts.keyterms !== undefined) {
    params.set("keyterms_prompt", JSON.stringify(opts.keyterms));
  }
  if (opts.prompt !== undefined) params.set("prompt", opts.prompt);
  if (opts.minTurnSilence !== undefined) {
    params.set("min_turn_silence", String(opts.minTurnSilence));
  }
  if (opts.maxTurnSilence !== undefined) {
    params.set("max_turn_silence", String(opts.maxTurnSilence));
  }
  if (opts.interruptionDelay !== undefined) {
    params.set("interruption_delay", String(opts.interruptionDelay));
  }
  if (opts.vadThreshold !== undefined) {
    params.set("vad_threshold", String(opts.vadThreshold));
  }
  if (opts.continuousPartials !== undefined) {
    params.set("continuous_partials", String(opts.continuousPartials));
  }
  if (opts.languageDetection !== undefined) {
    params.set("language_detection", String(opts.languageDetection));
  }

  return `${base}?${params.toString()}`;
}

/**
 * AssemblyAI Universal-3 Pro Streaming STT provider for the Cloudflare Agents
 * voice pipeline. Connects via WebSocket per call; the model handles turn
 * detection via punctuation (no client-side speech-boundary signalling needed).
 *
 * @example
 * ```ts
 * import { Agent } from "agents";
 * import { withVoice, WorkersAITTS } from "@cloudflare/voice";
 * import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   transcriber = new AssemblyAISTT({ apiKey: this.env.ASSEMBLYAI_API_KEY });
 *   tts = new WorkersAITTS(this.env.AI);
 * }
 * ```
 */
export class AssemblyAISTT implements Transcriber {
  #options: AssemblyAISTTOptions;

  constructor(options: AssemblyAISTTOptions) {
    this.#options = options;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new AssemblyAISession(this.#options, options);
  }
}

/**
 * Per-call AssemblyAI streaming session. Lives for the entire call. Connects
 * via a Cloudflare `fetch()` WebSocket upgrade, buffers audio fed before the
 * socket is ready, and tears down by sending a `Terminate` message and closing.
 */
class AssemblyAISession implements TranscriberSession {
  #providerOpts: AssemblyAISTTOptions;
  #sessionOpts: TranscriberSessionOptions | undefined;
  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;
  #pendingChunks: ArrayBuffer[] = [];

  constructor(
    providerOpts: AssemblyAISTTOptions,
    sessionOpts?: TranscriberSessionOptions
  ) {
    this.#providerOpts = providerOpts;
    this.#sessionOpts = sessionOpts;
    void this.#connect();
  }

  async #connect(): Promise<void> {
    try {
      const url = _buildConnectionUrl(this.#providerOpts);
      const resp = await fetch(url, {
        headers: {
          Upgrade: "websocket",
          // AssemblyAI Streaming v3 takes the raw API key — no Bearer/Token prefix.
          Authorization: this.#providerOpts.apiKey
        }
      });

      const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        console.error(
          "[AssemblyAISTT] Failed to establish WebSocket connection"
        );
        return;
      }

      // Race: if close() was called before the socket arrived, accept and
      // immediately close to release the connection.
      if (this.#closed) {
        ws.accept();
        ws.close();
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
        console.error("[AssemblyAISTT] WebSocket error:", event);
        this.#connected = false;
      });

      // Flush any audio fed before the socket was ready.
      for (const chunk of this.#pendingChunks) ws.send(chunk);
      this.#pendingChunks = [];
    } catch (err) {
      console.error("[AssemblyAISTT] Connection error:", err);
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
    // Wired in a later task.
  }

  #handleMessage(event: MessageEvent): void {
    if (this.#closed) return;

    let data: Record<string, unknown> | null;
    try {
      data =
        typeof event.data === "string"
          ? (JSON.parse(event.data) as Record<string, unknown>)
          : null;
    } catch {
      return; // ignore malformed JSON
    }
    if (!data || typeof data.type !== "string") return;

    if (data.type === "Turn") {
      const transcript =
        typeof data.transcript === "string" ? data.transcript : "";

      // Language metadata travels alongside the transcript. Surface it
      // independently because the pipeline callbacks are text-only.
      const code =
        typeof data.language_code === "string" ? data.language_code : undefined;
      const confidence =
        typeof data.language_confidence === "number"
          ? data.language_confidence
          : undefined;
      if (code !== undefined && confidence !== undefined) {
        this.#providerOpts.onLanguageDetected?.(code, confidence);
      }

      if (!transcript) return;
      if (data.end_of_turn === true) {
        this.#sessionOpts?.onUtterance?.(transcript);
      } else {
        this.#sessionOpts?.onInterim?.(transcript);
      }
      return;
    }

    if (data.type === "SpeechStarted") {
      this.#sessionOpts?.onSpeechStart?.();
      return;
    }
  }
}
