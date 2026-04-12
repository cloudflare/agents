import { Agent, type Connection, type WSMessage } from "agents";
import { withVoice, type VoiceTurnContext } from "../../voice";
import type {
  TTSProvider,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "../../types";

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

/**
 * Deterministic continuous transcriber session for tests.
 * Fires onUtterance every `utteranceThreshold` bytes accumulated.
 */
class TestTranscriberSession implements TranscriberSession {
  #totalBytes = 0;
  #utteranceCount = 0;
  #closed = false;
  #onInterim: ((text: string) => void) | undefined;
  #onUtterance: ((text: string) => void) | undefined;
  #utteranceThreshold: number;

  constructor(options?: TranscriberSessionOptions, utteranceThreshold = 20000) {
    this.#onInterim = options?.onInterim;
    this.#onUtterance = options?.onUtterance;
    this.#utteranceThreshold = utteranceThreshold;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;
    this.#totalBytes += chunk.byteLength;
    this.#onInterim?.(`hearing ${this.#totalBytes} bytes`);

    const nextThreshold = (this.#utteranceCount + 1) * this.#utteranceThreshold;
    if (this.#totalBytes >= nextThreshold) {
      this.#utteranceCount++;
      const transcript = `utterance ${this.#utteranceCount} (${this.#totalBytes} bytes)`;
      this.#onUtterance?.(transcript);
    }
  }

  close(): void {
    this.#closed = true;
  }
}

class TestTranscriber implements Transcriber {
  #utteranceThreshold: number;

  constructor(utteranceThreshold = 20000) {
    this.#utteranceThreshold = utteranceThreshold;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new TestTranscriberSession(options, this.#utteranceThreshold);
  }
}

// --- Test agents ---

const VoiceBase = withVoice(Agent);

/**
 * Test VoiceAgent with continuous transcriber.
 * Echoes back the transcript (no real AI).
 */
export class TestVoiceAgent extends VoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  tts = new TestTTS();

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

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message);
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

  getMessageCount(): number {
    return (
      this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_voice_messages
    `[0]?.count ?? 0
    );
  }
}
