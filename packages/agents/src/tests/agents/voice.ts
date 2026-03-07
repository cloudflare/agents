import { Agent, type Connection, type WSMessage } from "../../index";
import {
  withVoice,
  type VoiceTurnContext
} from "../../experimental/voice/voice";
import type {
  STTProvider,
  TTSProvider,
  VADProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions
} from "../../experimental/voice/types";

/** Deterministic STT provider for tests. */
class TestSTT implements STTProvider {
  async transcribe(_audioData: ArrayBuffer): Promise<string> {
    return "test transcript";
  }
}

/** Deterministic TTS provider for tests — encodes text as bytes. */
class TestTTS implements TTSProvider {
  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const buffer = new ArrayBuffer(text.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < text.length; i++) {
      view[i] = text.charCodeAt(i) & 0xff;
    }
    return buffer;
  }
}

/** Deterministic VAD provider for tests — always confirms end-of-turn. */
class TestVAD implements VADProvider {
  async checkEndOfTurn(
    _audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }> {
    return { isComplete: true, probability: 1.0 };
  }
}

const VoiceBase = withVoice(Agent);

/**
 * Test VoiceAgent that echoes back the transcript (no real AI).
 * Uses deterministic test providers for STT/TTS/VAD.
 */
export class TestVoiceAgent extends VoiceBase<Record<string, unknown>> {
  static options = { hibernate: false };

  stt = new TestSTT();
  tts = new TestTTS();
  vad = new TestVAD();

  #callStartCount = 0;
  #callEndCount = 0;
  #interruptCount = 0;
  #beforeCallStartResult = true;

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<string> {
    return `Echo: ${transcript}`;
  }

  beforeCallStart(_connection: Connection): boolean {
    return this.#beforeCallStartResult;
  }

  onCallStart(_connection: Connection) {
    this.#callStartCount++;
  }

  onCallEnd(_connection: Connection) {
    this.#callEndCount++;
  }

  onInterrupt(_connection: Connection) {
    this.#interruptCount++;
  }

  onNonVoiceMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message);
      // Control messages for testing
      switch (parsed.type) {
        case "_set_before_call_start":
          this.#beforeCallStartResult = parsed.value;
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_get_counts":
          connection.send(
            JSON.stringify({
              type: "_counts",
              callStart: this.#callStartCount,
              callEnd: this.#callEndCount,
              interrupt: this.#interruptCount
            })
          );
          break;
        case "_get_message_count":
          connection.send(
            JSON.stringify({
              type: "_message_count",
              count: this.getMessageCount()
            })
          );
          break;
        case "_force_end_call":
          this.forceEndCall(connection);
          break;
      }
    } catch {
      // ignore
    }
  }

  getCallStartCount(): number {
    return this.#callStartCount;
  }

  getCallEndCount(): number {
    return this.#callEndCount;
  }

  getInterruptCount(): number {
    return this.#interruptCount;
  }

  setBeforeCallStartResult(result: boolean) {
    this.#beforeCallStartResult = result;
  }

  getMessageCount(): number {
    return (
      this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_voice_messages
    `[0]?.count ?? 0
    );
  }
}

// --- Streaming STT test provider ---

/**
 * Deterministic streaming STT provider for tests.
 *
 * Simulates a real streaming STT service:
 * - feed() accumulates audio bytes
 * - Fires onInterim after each feed() with a running byte count
 * - Fires onFinal when accumulated bytes cross a threshold (10000)
 * - finish() returns the final transcript based on total bytes received
 */
class TestStreamingSTTSession implements StreamingSTTSession {
  #totalBytes = 0;
  #finalSegments: string[] = [];
  #aborted = false;

  onInterim: ((text: string) => void) | null = null;
  onFinal: ((text: string) => void) | null = null;
  onEndOfTurn: ((text: string) => void) | null = null;

  feed(chunk: ArrayBuffer): void {
    if (this.#aborted) return;
    this.#totalBytes += chunk.byteLength;

    // Fire interim with running byte count
    this.onInterim?.(`hearing ${this.#totalBytes} bytes`);

    // Fire final segment every 10000 bytes
    if (this.#totalBytes >= (this.#finalSegments.length + 1) * 10000) {
      const segment = `segment-${this.#finalSegments.length + 1}`;
      this.#finalSegments.push(segment);
      this.onFinal?.(segment);
    }
  }

  async finish(): Promise<string> {
    if (this.#aborted) return "";
    // Return a deterministic transcript based on total bytes
    return `streaming transcript (${this.#totalBytes} bytes)`;
  }

  abort(): void {
    this.#aborted = true;
  }
}

class TestStreamingSTT implements StreamingSTTProvider {
  createSession(_options?: StreamingSTTSessionOptions): StreamingSTTSession {
    return new TestStreamingSTTSession();
  }
}

// --- EOT-capable streaming STT test provider ---

/**
 * Streaming STT session that fires onEndOfTurn when enough audio arrives.
 * Simulates a provider with built-in end-of-turn detection (like Flux).
 *
 * Behavior:
 * - feed() accumulates bytes and fires onInterim
 * - When total bytes >= 20000, fires onEndOfTurn with a stable transcript
 * - finish() returns the transcript (may be called before or after EOT)
 */
class TestEOTStreamingSTTSession implements StreamingSTTSession {
  #totalBytes = 0;
  #aborted = false;
  #eotFired = false;

  onInterim: ((text: string) => void) | null = null;
  onFinal: ((text: string) => void) | null = null;
  onEndOfTurn: ((text: string) => void) | null = null;

  feed(chunk: ArrayBuffer): void {
    if (this.#aborted) return;
    this.#totalBytes += chunk.byteLength;

    this.onInterim?.(`hearing ${this.#totalBytes} bytes`);

    // Fire EOT once when we have enough audio
    if (this.#totalBytes >= 20000 && !this.#eotFired) {
      this.#eotFired = true;
      const transcript = `eot transcript (${this.#totalBytes} bytes)`;
      this.onFinal?.(transcript);
      this.onEndOfTurn?.(transcript);
    }
  }

  async finish(): Promise<string> {
    if (this.#aborted) return "";
    return `eot transcript (${this.#totalBytes} bytes)`;
  }

  abort(): void {
    this.#aborted = true;
  }
}

class TestEOTStreamingSTT implements StreamingSTTProvider {
  createSession(_options?: StreamingSTTSessionOptions): StreamingSTTSession {
    return new TestEOTStreamingSTTSession();
  }
}

/**
 * VAD that rejects the first end-of-speech per connection, then accepts.
 * Used to test the VAD retry timer recovery path.
 */
class TestRejectingVAD implements VADProvider {
  #callCount = 0;

  async checkEndOfTurn(
    _audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }> {
    this.#callCount++;
    if (this.#callCount === 1) {
      // First call: reject
      return { isComplete: false, probability: 0.1 };
    }
    // Subsequent calls: accept
    return { isComplete: true, probability: 1.0 };
  }
}

const VoiceBaseVadRetry = withVoice(Agent, { vadRetryMs: 200 });

/**
 * Test VoiceAgent whose VAD rejects the first end-of-speech.
 * Uses a short vadRetryMs (200ms) so the retry timer fires quickly in tests.
 * Verifies the deadlock recovery: client sends end_of_speech → VAD rejects →
 * retry timer fires → processes without VAD.
 */
export class TestVadRetryVoiceAgent extends VoiceBaseVadRetry<
  Record<string, unknown>
> {
  static options = { hibernate: false };

  stt = new TestSTT();
  tts = new TestTTS();
  vad = new TestRejectingVAD();

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<string> {
    return `Echo: ${transcript}`;
  }
}

/**
 * Test VoiceAgent that uses streaming STT instead of batch STT.
 * Echoes back the streaming transcript.
 */
export class TestStreamingVoiceAgent extends VoiceBase<
  Record<string, unknown>
> {
  static options = { hibernate: false };

  streamingStt = new TestStreamingSTT();
  tts = new TestTTS();
  vad = new TestVAD();

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<string> {
    return `Echo: ${transcript}`;
  }
}

/**
 * Test VoiceAgent that uses an EOT-capable streaming STT provider.
 * The provider fires onEndOfTurn when it accumulates >= 20000 bytes,
 * which triggers the pipeline immediately without waiting for the
 * client to send end_of_speech.
 *
 * No VAD is configured — Flux-like providers handle turn detection.
 */
export class TestEotVoiceAgent extends VoiceBase<Record<string, unknown>> {
  static options = { hibernate: false };

  streamingStt = new TestEOTStreamingSTT();
  tts = new TestTTS();

  #callStartCount = 0;
  #callEndCount = 0;
  #interruptCount = 0;

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<string> {
    return `Echo: ${transcript}`;
  }

  onCallStart(_connection: Connection) {
    this.#callStartCount++;
  }

  onCallEnd(_connection: Connection) {
    this.#callEndCount++;
  }

  onInterrupt(_connection: Connection) {
    this.#interruptCount++;
  }

  onNonVoiceMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message);
      switch (parsed.type) {
        case "_get_counts":
          connection.send(
            JSON.stringify({
              type: "_counts",
              callStart: this.#callStartCount,
              callEnd: this.#callEndCount,
              interrupt: this.#interruptCount
            })
          );
          break;
        case "_get_message_count":
          connection.send(
            JSON.stringify({
              type: "_message_count",
              count: this.getMessageCount()
            })
          );
          break;
        case "_force_end_call":
          this.forceEndCall(connection);
          break;
      }
    } catch {
      // ignore
    }
  }

  getMessageCount(): number {
    return (
      this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_voice_messages
    `[0]?.count ?? 0
    );
  }
}
