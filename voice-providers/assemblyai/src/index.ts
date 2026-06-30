/**
 * @cloudflare/voice-assemblyai — AssemblyAI streaming STT provider for the
 * Cloudflare Agents voice pipeline. Uses AssemblyAI Universal 3.5 Pro Realtime
 * (`universal-3-5-pro`); see README.md for options.
 */

import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "@cloudflare/voice";

/**
 * Latency/accuracy preset → `mode`. `balanced` (the server default) is best for
 * voice agents; `min_latency` minimizes time-to-text; `max_accuracy` is for
 * scribes / post-call. The mode sets the per-mode defaults for turn-silence,
 * partials, VAD, and interruption timing — only override those when you have a
 * specific reason to.
 */
export type AssemblyAIMode = "min_latency" | "balanced" | "max_accuracy";

/**
 * Voice Focus noise-suppression variant → `voice_focus`. `near-field` for
 * headsets/handsets/close-talking mics, `far-field` for conference rooms,
 * laptop mics, and other distant capture.
 */
export type AssemblyAIVoiceFocus = "near-field" | "far-field";

/**
 * Languages biased by `language_code` on `universal-3-5-pro`. Set when the
 * session is known to be monolingual for better accuracy; omit to keep default
 * multilingual code-switching. The `string & {}` arm keeps autocomplete while
 * allowing forward-compat values.
 */
export type AssemblyAILanguageCode =
  | "en"
  | "es"
  | "de"
  | "fr"
  | "it"
  | "pt"
  | "tr"
  | "nl"
  | "sv"
  | "no"
  | "da"
  | "fi"
  | "hi"
  | "vi"
  | "ar"
  | "he"
  | "ja"
  | "ur"
  | "zh"
  | (string & {});

/**
 * The single model this provider targets: AssemblyAI Universal 3.5 Pro
 * Realtime. It supports `mode`, `prompt`, `agent_context`,
 * `previous_context_n_turns`, `voice_focus`, and language detection.
 */
const SPEECH_MODEL = "universal-3-5-pro";

const DEFAULT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";

/** Server-side cap on `prompt` and `agent_context` (characters). */
const MAX_PROMPT_CHARS = 1750;

export interface AssemblyAISTTOptions {
  /** AssemblyAI API key. Sent as the `Authorization` header (raw key, no prefix). */
  apiKey: string;
  /**
   * Latency/accuracy preset → `mode`. Omit to use AssemblyAI's `balanced`
   * default (recommended for voice agents). The mode owns the per-mode tuning
   * for turn silence, partials, VAD, and interruption timing.
   */
  mode?: AssemblyAIMode;
  /**
   * Domain specialization → `domain=<value>`. `"medical-v1"` enables Medical
   * Mode (en/es/de/fr); the union keeps autocomplete for the known value while
   * accepting any string for forward-compat.
   */
  domain?: "medical-v1" | (string & {});
  /** Domain vocabulary to bias recognition → `keyterms_prompt` (JSON-encoded). */
  keyterms?: string[];
  /**
   * Natural-language context about the audio (domain, topic, scenario) →
   * `prompt`. **Not** behavioral/formatting instructions — the transcription
   * behavior is managed by AssemblyAI. Omit to use the optimized default.
   * Max 1750 characters. Can be combined with `keyterms`.
   */
  prompt?: string;
  /**
   * Seed the agent's most recent spoken reply (TTS text) at connection time →
   * `agent_context`. Use it to prime context for the user's first answer (e.g.
   * an opening greeting). Update it as the conversation progresses via the
   * session's `updateAgentContext()`. Max 1750 characters.
   */
  agentContext?: string;
  /**
   * Max prior conversation entries (finalized user transcripts plus any
   * `agent_context` values) carried forward as context → `previous_context_n_turns`.
   * Range 0–100; `0` disables automatic context carryover. Omit to use the
   * server default (~3).
   */
  previousContextNTurns?: number;
  /**
   * Bias the model toward a single language → `language_code`. Set when the
   * session is monolingual; omit to keep default multilingual code-switching.
   */
  languageCode?: AssemblyAILanguageCode;
  /**
   * Voice Focus noise suppression → `voice_focus`. Isolates the primary voice
   * and suppresses background noise before audio reaches the model. Omit to
   * disable.
   */
  voiceFocus?: AssemblyAIVoiceFocus;
  /**
   * How aggressively Voice Focus suppresses background audio → `voice_focus_threshold`
   * (0–1, higher = more aggressive). Requires `voiceFocus` to be set.
   */
  voiceFocusThreshold?: number;
  /** Min silence (ms) before EOT check → `min_turn_silence`. Omit to use the `mode` default. */
  minTurnSilence?: number;
  /** Max silence (ms) before forced EOT → `max_turn_silence`. Omit to use the `mode` default. */
  maxTurnSilence?: number;
  /** First-partial / barge-in timing 0–1000 ms → `interruption_delay`. Omit to use the `mode` default. */
  interruptionDelay?: number;
  /** VAD silence-confidence threshold 0–1 → `vad_threshold`. Raise in noisy environments. */
  vadThreshold?: number;
  /**
   * Steady ~3 s partials during long uninterrupted turns → `continuous_partials`.
   * Omit to use the `mode` default; set explicitly to override.
   */
  continuousPartials?: boolean;
  /**
   * Return detected-language metadata on Turn events → `language_detection`.
   * `universal-3-5-pro` code-switches natively; enable this only when you need
   * the per-turn language reported. Surface it via `onLanguageDetected`.
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

/**
 * Build the AssemblyAI Streaming v3 WebSocket URL from provider options.
 * Underscore-prefixed: internal helper, exported only for unit tests.
 */
export function _buildConnectionUrl(opts: AssemblyAISTTOptions): string {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    speech_model: SPEECH_MODEL,
    sample_rate: "16000",
    encoding: "pcm_s16le"
  });

  if (opts.mode !== undefined) params.set("mode", opts.mode);
  if (opts.domain !== undefined) params.set("domain", opts.domain);
  if (opts.keyterms !== undefined) {
    params.set("keyterms_prompt", JSON.stringify(opts.keyterms));
  }
  if (opts.prompt !== undefined) params.set("prompt", opts.prompt);
  if (opts.agentContext !== undefined) {
    params.set("agent_context", opts.agentContext);
  }
  if (opts.previousContextNTurns !== undefined) {
    params.set("previous_context_n_turns", String(opts.previousContextNTurns));
  }
  if (opts.languageCode !== undefined) {
    params.set("language_code", opts.languageCode);
  }
  if (opts.voiceFocus !== undefined) {
    params.set("voice_focus", opts.voiceFocus);
  }
  if (opts.voiceFocusThreshold !== undefined) {
    params.set("voice_focus_threshold", String(opts.voiceFocusThreshold));
  }
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
 * Validate option combinations at construction. Fails fast (like the LiveKit
 * plugin) so a typo or out-of-range value surfaces as a clear config error
 * rather than a server-side rejection mid-call.
 */
function assertValidOptions(opts: AssemblyAISTTOptions): void {
  if (opts.voiceFocusThreshold !== undefined && opts.voiceFocus === undefined) {
    throw new Error(
      "AssemblyAISTT: 'voiceFocusThreshold' requires 'voiceFocus' to be set."
    );
  }
  if (opts.prompt !== undefined && opts.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `AssemblyAISTT: 'prompt' exceeds the maximum of ${MAX_PROMPT_CHARS} characters (got ${opts.prompt.length}).`
    );
  }
  if (
    opts.agentContext !== undefined &&
    opts.agentContext.length > MAX_PROMPT_CHARS
  ) {
    throw new Error(
      `AssemblyAISTT: 'agentContext' exceeds the maximum of ${MAX_PROMPT_CHARS} characters (got ${opts.agentContext.length}).`
    );
  }
  if (
    opts.interruptionDelay !== undefined &&
    (opts.interruptionDelay < 0 || opts.interruptionDelay > 1000)
  ) {
    throw new Error(
      `AssemblyAISTT: 'interruptionDelay' must be between 0 and 1000 ms (got ${opts.interruptionDelay}).`
    );
  }
  if (
    opts.previousContextNTurns !== undefined &&
    (opts.previousContextNTurns < 0 || opts.previousContextNTurns > 100)
  ) {
    throw new Error(
      `AssemblyAISTT: 'previousContextNTurns' must be between 0 and 100 (got ${opts.previousContextNTurns}).`
    );
  }
}

/**
 * AssemblyAI Universal 3.5 Pro Realtime STT provider for the Cloudflare Agents
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
    assertValidOptions(options);
    this.#options = options;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    // `options.language` is intentionally ignored: steer language via the
    // `languageCode` provider option (`language_code`) instead, which
    // universal-3-5-pro biases toward when the session is monolingual.
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
  // Latest agent_context queued before the socket was ready. Only the most
  // recent value matters — older ones are stale once the agent speaks again.
  #pendingAgentContext: string | null = null;

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

      // Apply any agent_context queued before the socket was ready, then flush
      // buffered audio.
      if (this.#pendingAgentContext !== null) {
        this.#sendAgentContext(this.#pendingAgentContext);
        this.#pendingAgentContext = null;
      }
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

  /**
   * Update the conversational `agent_context` mid-session with the agent's most
   * recent spoken reply (TTS text). Sent as an `UpdateConfiguration` message so
   * the model knows the question the user is answering — especially valuable for
   * short replies ("yes", "7pm", a name) and spelled-out entities. Capped to the
   * last {@link MAX_PROMPT_CHARS} characters; empty/whitespace text is a no-op.
   */
  updateAgentContext(text: string): void {
    if (this.#closed) return;
    // Carryover is explicitly disabled: the server discards agent_context when
    // previous_context_n_turns is 0, so skip the pointless UpdateConfiguration.
    if (this.#providerOpts.previousContextNTurns === 0) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const capped =
      trimmed.length > MAX_PROMPT_CHARS
        ? trimmed.slice(-MAX_PROMPT_CHARS)
        : trimmed;

    if (this.#connected && this.#ws) {
      this.#sendAgentContext(capped);
    } else {
      // Keep only the latest — older agent replies are stale by connect time.
      this.#pendingAgentContext = capped;
    }
  }

  #sendAgentContext(agentContext: string): void {
    if (!this.#ws) return;
    this.#ws.send(
      JSON.stringify({
        type: "UpdateConfiguration",
        agent_context: agentContext
      })
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingChunks = [];
    this.#pendingAgentContext = null;

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
