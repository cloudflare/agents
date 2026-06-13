/**
 * Shared audio pipeline utilities and per-connection state management.
 * Used internally by both withVoice and withVoiceInput mixins.
 */

import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "./types";

/** Max audio buffer size per connection: 30 seconds at 16kHz mono 16-bit = 960KB. */
export const MAX_AUDIO_BUFFER_BYTES = 960_000;

// --- Teardown-aware background task helper ---

/**
 * True when an error is the platform's signal that a connection (or its
 * Durable Object) was torn down while an operation was in flight. A client
 * can drop at any moment — including mid-`start_call` while a `keepAlive()`
 * alarm write is still pending — and the runtime surfaces that as a
 * retryable "Network connection lost." rejection (or a Durable Object reset).
 * These are expected races during shutdown, not bugs.
 */
export function isConnectionTeardownError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { message?: unknown; retryable?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  return (
    e.retryable === true ||
    message.includes("Network connection lost") ||
    message.includes("Durable Object reset") ||
    message.includes("Durable Object is overloaded") ||
    message.includes("cannot access storage")
  );
}

/**
 * Run a fire-and-forget task triggered by a WebSocket message so that it can
 * never surface as an unhandled rejection. Voice lifecycle handlers (start
 * call, end call, interrupt, transcript emission) do async work — storage
 * writes for `keepAlive()`, user-defined hooks — but are dispatched without
 * being awaited from the synchronous `onMessage` handler. If the connection
 * is torn down before that work settles, the rejection would otherwise be
 * unhandled. Expected teardown races are swallowed; anything else is logged.
 */
export function runBackground(
  label: string,
  fn: () => void | Promise<void>
): void {
  Promise.resolve()
    .then(fn)
    .catch((err: unknown) => {
      if (isConnectionTeardownError(err)) return;
      console.error(`[voice] ${label} failed:`, err);
    });
}

// --- Protocol helper ---

export function sendVoiceJSON(
  connection: { send(data: string | ArrayBuffer): void },
  data: unknown,
  _logPrefix: string,
  _skipLog = false
): void {
  const json = JSON.stringify(data);
  connection.send(json);
}

// --- Connection audio state manager ---

/**
 * Manages per-connection audio pipeline state for voice mixins.
 * Owns the Maps for audio buffers, transcriber sessions, and abort controllers.
 * Does not own pipeline orchestration — that stays in each mixin.
 */
export class AudioConnectionManager {
  #audioBuffers = new Map<string, ArrayBuffer[]>();
  #transcriberSessions = new Map<string, TranscriberSession>();
  #activePipeline = new Map<string, AbortController>();
  constructor(_logPrefix: string) {}

  // --- Connection lifecycle ---

  initConnection(connectionId: string): void {
    if (!this.#audioBuffers.has(connectionId)) {
      this.#audioBuffers.set(connectionId, []);
    }
  }

  isInCall(connectionId: string): boolean {
    return this.#audioBuffers.has(connectionId);
  }

  cleanup(connectionId: string): void {
    this.abortPipeline(connectionId);
    this.#audioBuffers.delete(connectionId);
    this.closeTranscriberSession(connectionId);
  }

  // --- Audio buffering ---

  bufferAudio(connectionId: string, chunk: ArrayBuffer): void {
    const buffer = this.#audioBuffers.get(connectionId);
    if (!buffer) return;
    buffer.push(chunk);

    let totalBytes = 0;
    for (const buf of buffer) totalBytes += buf.byteLength;

    // Trim to max buffer size
    while (totalBytes > MAX_AUDIO_BUFFER_BYTES && buffer.length > 1) {
      totalBytes -= buffer.shift()!.byteLength;
    }

    // Feed to transcriber session if active
    const session = this.#transcriberSessions.get(connectionId);
    if (session) {
      session.feed(chunk);
    }
  }

  clearAudioBuffer(connectionId: string): void {
    if (this.#audioBuffers.has(connectionId)) {
      this.#audioBuffers.set(connectionId, []);
    }
  }

  // --- Transcriber sessions ---

  hasTranscriberSession(connectionId: string): boolean {
    return this.#transcriberSessions.has(connectionId);
  }

  startTranscriberSession(
    connectionId: string,
    transcriber: Transcriber,
    options: TranscriberSessionOptions
  ): void {
    this.closeTranscriberSession(connectionId);
    const session = transcriber.createSession(options);
    this.#transcriberSessions.set(connectionId, session);
  }

  closeTranscriberSession(connectionId: string): void {
    const session = this.#transcriberSessions.get(connectionId);
    if (session) {
      session.close();
      this.#transcriberSessions.delete(connectionId);
    }
  }

  // --- Pipeline abort ---

  /**
   * Abort any in-flight pipeline and create a new AbortController.
   * Returns the new AbortSignal.
   */
  createPipelineAbort(connectionId: string): AbortSignal {
    this.abortPipeline(connectionId);
    const controller = new AbortController();
    this.#activePipeline.set(connectionId, controller);
    return controller.signal;
  }

  abortPipeline(connectionId: string): boolean {
    const controller = this.#activePipeline.get(connectionId);
    if (!controller) return false;
    controller.abort();
    this.#activePipeline.delete(connectionId);
    return true;
  }

  /**
   * Clear a pipeline abort controller only if it still matches the
   * given signal. Prevents a finished pipeline from deleting a
   * successor pipeline's controller in a concurrent scenario.
   */
  clearPipelineAbort(connectionId: string, signal?: AbortSignal): void {
    if (signal) {
      const controller = this.#activePipeline.get(connectionId);
      if (controller && controller.signal === signal) {
        this.#activePipeline.delete(connectionId);
      }
    } else {
      this.#activePipeline.delete(connectionId);
    }
  }
}
