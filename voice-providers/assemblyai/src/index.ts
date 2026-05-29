/**
 * @cloudflare/voice-assemblyai — AssemblyAI streaming STT provider for the
 * Cloudflare Agents voice pipeline. Defaults to Universal-3 Pro Streaming
 * (`u3-rt-pro`); see README.md for options and model selection.
 */

import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "@cloudflare/voice";

/**
 * AssemblyAI Streaming v3 speech models. `u3-rt-pro` (the default) is the
 * Universal-3 Pro Streaming voice-agent model — punctuation-based turn
 * detection, barge-in `SpeechStarted` events, and promptable transcription.
 * The `universal-streaming-*` models use confidence-based turn detection
 * (tuned via `min`/`maxTurnSilence`) and do **not** emit `SpeechStarted`.
 * The `string & {}` arm keeps autocomplete while allowing forward-compat values.
 */
export type AssemblyAISpeechModel =
  | "u3-rt-pro"
  | "universal-streaming-english"
  | "universal-streaming-multilingual"
  | (string & {});

/** The only model that supports `prompt`/`continuousPartials`/`interruptionDelay`. */
const DEFAULT_SPEECH_MODEL = "u3-rt-pro";

export interface AssemblyAISTTOptions {
  /** AssemblyAI API key. Sent as the `Authorization` header (raw key, no prefix). */
  apiKey: string;
  /**
   * Streaming model → `speech_model`. **Defaults to `"u3-rt-pro"`** (Universal-3
   * Pro Streaming). `prompt`, `continuousPartials`, and `interruptionDelay` are
   * `u3-rt-pro`-only and throw at construction if set with another model. The
   * `universal-streaming-*` models tune turn detection via `min`/`maxTurnSilence`,
   * and barge-in (`onSpeechStart`) only fires on `u3-rt-pro`.
   * @default "u3-rt-pro"
   */
  speechModel?: AssemblyAISpeechModel;
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
  /**
   * Min silence (ms) before EOT check → `min_turn_silence`.
   * @default 400 (AssemblyAI server default is 100)
   */
  minTurnSilence?: number;
  /**
   * Max silence (ms) before forced EOT → `max_turn_silence`.
   * @default 1280 (AssemblyAI server default is 1000)
   */
  maxTurnSilence?: number;
  /** First-partial timing 0–1000 ms → `interruption_delay`. Server default 500. */
  interruptionDelay?: number;
  /** VAD silence-confidence threshold 0–1 → `vad_threshold`. Raise in noisy environments. */
  vadThreshold?: number;
  /**
   * Steady ~3 s partials during long uninterrupted turns → `continuous_partials`.
   * **Defaults to `true` on `u3-rt-pro`** (off otherwise) so the live transcript
   * keeps updating mid-turn instead of only at pauses. Set `false` to opt out.
   */
  continuousPartials?: boolean;
  /**
   * Return detected-language metadata on Turn events → `language_detection`.
   * A `universal-streaming-multilingual` feature (`u3-rt-pro` detects language
   * automatically via code-switching). Surface it via `onLanguageDetected`.
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
   * Full WebSocket base URL override — e.g. the EU host
   * (`wss://streaming.eu.assemblyai.com/v3/ws`) or a self-hosted proxy.
   * @default "wss://streaming.assemblyai.com/v3/ws"
   */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";

// Turn-detection silence windows. The plugin defaults these above AssemblyAI's
// server defaults (100/1000 ms): a slightly longer min and max give speakers
// more room to pause mid-thought before an end-of-turn fires, which in practice
// cuts off fewer turns. Callers can still override via `min`/`maxTurnSilence`.
const DEFAULT_MIN_TURN_SILENCE = 400;
const DEFAULT_MAX_TURN_SILENCE = 1280;

/**
 * Build the AssemblyAI Streaming v3 WebSocket URL from provider options.
 * Underscore-prefixed: internal helper, exported only for unit tests.
 */
export function _buildConnectionUrl(opts: AssemblyAISTTOptions): string {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const model = opts.speechModel ?? DEFAULT_SPEECH_MODEL;
  const params = new URLSearchParams({
    speech_model: model,
    sample_rate: "16000",
    encoding: "pcm_s16le"
  });

  if (opts.domain !== undefined) params.set("domain", opts.domain);
  if (opts.keyterms !== undefined) {
    params.set("keyterms_prompt", JSON.stringify(opts.keyterms));
  }
  if (opts.prompt !== undefined) params.set("prompt", opts.prompt);
  params.set(
    "min_turn_silence",
    String(opts.minTurnSilence ?? DEFAULT_MIN_TURN_SILENCE)
  );
  params.set(
    "max_turn_silence",
    String(opts.maxTurnSilence ?? DEFAULT_MAX_TURN_SILENCE)
  );
  if (opts.interruptionDelay !== undefined) {
    params.set("interruption_delay", String(opts.interruptionDelay));
  }
  if (opts.vadThreshold !== undefined) {
    params.set("vad_threshold", String(opts.vadThreshold));
  }
  // Default continuous_partials on for u3-rt-pro: a steady ~3s stream of mid-turn
  // partials (vs. silence-only partials) gives a live transcript during long
  // uninterrupted speech. u3-rt-pro-only, so don't default it for other models.
  const continuousPartials =
    opts.continuousPartials ??
    (model === DEFAULT_SPEECH_MODEL ? true : undefined);
  if (continuousPartials !== undefined) {
    params.set("continuous_partials", String(continuousPartials));
  }
  if (opts.languageDetection !== undefined) {
    params.set("language_detection", String(opts.languageDetection));
  }

  return `${base}?${params.toString()}`;
}

/**
 * Throw if options combine a non-`u3-rt-pro` model with a `u3-rt-pro`-only
 * parameter. Fails fast at construction (like the LiveKit plugin) so a typo
 * surfaces as a clear config error rather than a silently-ignored param or a
 * server-side rejection mid-call.
 */
function assertModelCompatibleOptions(opts: AssemblyAISTTOptions): void {
  const model = opts.speechModel ?? DEFAULT_SPEECH_MODEL;
  if (model === DEFAULT_SPEECH_MODEL) return;

  const u3Only: Array<keyof AssemblyAISTTOptions> = [
    "prompt",
    "continuousPartials",
    "interruptionDelay"
  ];
  for (const opt of u3Only) {
    if (opts[opt] !== undefined) {
      throw new Error(
        `AssemblyAISTT: '${opt}' is only supported with the 'u3-rt-pro' speech model (got '${model}').`
      );
    }
  }
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
    assertModelCompatibleOptions(options);
    this.#options = options;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    // `options.language` is intentionally ignored: no current AssemblyAI
    // streaming model takes a `language` param (deprecated on Universal
    // Streaming, absent on u3-rt-pro, which code-switches natively). Guide
    // language via `prompt` on u3-rt-pro instead.
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
      // Cloudflare's fetch-based WebSocket upgrade requires the http(s) scheme;
      // it rejects ws://wss:// URLs. The handshake still negotiates a WebSocket
      // via the `Upgrade` header and `response.webSocket`.
      const url = _buildConnectionUrl(this.#providerOpts)
        .replace(/^wss:\/\//, "https://")
        .replace(/^ws:\/\//, "http://");
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
      ws.addEventListener("close", (event: CloseEvent) => {
        this.#connected = false;
        // Surface an unexpected close — fatal failures (auth `1008`, session
        // errors `3xxx`, network drops) arrive only as close frames, since the
        // shared `TranscriberSession` interface has no error callback. Skip
        // teardown we initiated (`close()`) and clean `1000` closures.
        if (!this.#closed && event.code !== 1000) {
          console.error(
            `[AssemblyAISTT] WebSocket closed: code=${event.code} reason=${event.reason || "(none)"}`
          );
        }
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
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingChunks = [];

    if (this.#ws && this.#connected) {
      try {
        this.#ws.send(JSON.stringify({ type: "Terminate" }));
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
