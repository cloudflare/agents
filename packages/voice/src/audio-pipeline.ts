/**
 * Shared audio pipeline utilities and per-connection state management.
 * Used internally by both withVoice and withVoiceInput mixins.
 */

import type {
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions
} from "./types";

// --- Audio utilities ---

export function concatenateBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}

// --- Default option values ---

export const DEFAULT_VAD_THRESHOLD = 0.5;
export const DEFAULT_MIN_AUDIO_BYTES = 16000; // 0.5s at 16kHz mono 16-bit
export const DEFAULT_VAD_PUSHBACK_SECONDS = 2;
export const DEFAULT_VAD_RETRY_MS = 3000;

/** Max audio buffer size per connection: 30 seconds at 16kHz mono 16-bit = 960KB. */
export const MAX_AUDIO_BUFFER_BYTES = 960_000;

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
 * Owns the Maps/Sets for audio buffers, STT sessions, timers, and abort controllers.
 * Does not own pipeline orchestration — that stays in each mixin.
 */
export class AudioConnectionManager {
  #audioBuffers = new Map<string, ArrayBuffer[]>();
  #sttSessions = new Map<string, StreamingSTTSession>();
  #vadRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #eotTriggered = new Set<string>();
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
    this.abortSTTSession(connectionId);
    this.clearVadRetry(connectionId);
    this.#eotTriggered.delete(connectionId);
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

    // Feed to streaming STT session if active
    const session = this.#sttSessions.get(connectionId);
    if (session) {
      session.feed(chunk);
    }
  }

  /**
   * Concatenate and clear the audio buffer for a connection.
   * Returns null if no audio or buffer doesn't exist.
   */
  getAndClearAudio(connectionId: string): ArrayBuffer | null {
    const chunks = this.#audioBuffers.get(connectionId);
    if (!chunks || chunks.length === 0) return null;
    const audio = concatenateBuffers(chunks);
    this.#audioBuffers.set(connectionId, []);
    return audio;
  }

  clearAudioBuffer(connectionId: string): void {
    if (this.#audioBuffers.has(connectionId)) {
      this.#audioBuffers.set(connectionId, []);
    }
  }

  pushbackAudio(connectionId: string, audio: ArrayBuffer): void {
    const buffer = this.#audioBuffers.get(connectionId);
    if (buffer) {
      buffer.unshift(audio);
    } else {
      this.#audioBuffers.set(connectionId, [audio]);
    }
  }

  // --- STT sessions ---

  hasSTTSession(connectionId: string): boolean {
    return this.#sttSessions.has(connectionId);
  }

  startSTTSession(
    connectionId: string,
    provider: StreamingSTTProvider,
    options: StreamingSTTSessionOptions
  ): void {
    const session = provider.createSession(options);
    this.#sttSessions.set(connectionId, session);
  }

  async flushSTTSession(connectionId: string): Promise<string> {
    const session = this.#sttSessions.get(connectionId);
    if (!session) return "";
    const transcript = await session.finish();
    this.#sttSessions.delete(connectionId);
    return transcript;
  }

  abortSTTSession(connectionId: string): void {
    const session = this.#sttSessions.get(connectionId);
    if (session) {
      session.abort();
      this.#sttSessions.delete(connectionId);
    }
  }

  /** Remove the STT session without aborting (used after provider-driven EOT). */
  removeSTTSession(connectionId: string): void {
    this.#sttSessions.delete(connectionId);
  }

  // --- EOT tracking ---

  isEOTTriggered(connectionId: string): boolean {
    return this.#eotTriggered.has(connectionId);
  }

  setEOTTriggered(connectionId: string): void {
    this.#eotTriggered.add(connectionId);
  }

  clearEOT(connectionId: string): void {
    this.#eotTriggered.delete(connectionId);
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

  abortPipeline(connectionId: string): void {
    this.#activePipeline.get(connectionId)?.abort();
    this.#activePipeline.delete(connectionId);
  }

  clearPipelineAbort(connectionId: string): void {
    this.#activePipeline.delete(connectionId);
  }

  // --- VAD retry ---

  scheduleVadRetry(
    connectionId: string,
    callback: () => void,
    retryMs: number
  ): void {
    this.clearVadRetry(connectionId);
    this.#vadRetryTimers.set(
      connectionId,
      setTimeout(() => {
        this.#vadRetryTimers.delete(connectionId);
        callback();
      }, retryMs)
    );
  }

  clearVadRetry(connectionId: string): void {
    const timer = this.#vadRetryTimers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      this.#vadRetryTimers.delete(connectionId);
    }
  }
}
