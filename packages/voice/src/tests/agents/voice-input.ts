import { Agent, type Connection, type WSMessage } from "agents";
import { withVoiceInput } from "../../voice-input";
import type {
  STTProvider,
  VADProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions
} from "../../types";

// --- Stub providers ---

/** Deterministic batch STT: returns a fixed transcript. */
class TestSTT implements STTProvider {
  async transcribe(_audioData: ArrayBuffer): Promise<string> {
    return "test input transcript";
  }
}

/** VAD that always confirms end-of-turn. */
class TestVAD implements VADProvider {
  async checkEndOfTurn(
    _audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }> {
    return { isComplete: true, probability: 1.0 };
  }
}

/** Streaming STT session with deterministic behavior. */
class TestStreamingSTTSession implements StreamingSTTSession {
  #totalBytes = 0;
  #aborted = false;
  #onInterim: ((text: string) => void) | undefined;

  constructor(options?: StreamingSTTSessionOptions) {
    this.#onInterim = options?.onInterim;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#aborted) return;
    this.#totalBytes += chunk.byteLength;
    this.#onInterim?.(`hearing ${this.#totalBytes} bytes`);
  }

  async finish(): Promise<string> {
    if (this.#aborted) return "";
    return `streaming input (${this.#totalBytes} bytes)`;
  }

  abort(): void {
    this.#aborted = true;
  }
}

class TestStreamingSTT implements StreamingSTTProvider {
  createSession(options?: StreamingSTTSessionOptions): StreamingSTTSession {
    return new TestStreamingSTTSession(options);
  }
}

/** EOT-capable streaming STT: fires onEndOfTurn at >= 20000 bytes. */
class TestEOTStreamingSTTSession implements StreamingSTTSession {
  #totalBytes = 0;
  #aborted = false;
  #eotFired = false;
  #onInterim: ((text: string) => void) | undefined;
  #onFinal: ((text: string) => void) | undefined;
  #onEndOfTurn: ((text: string) => void) | undefined;

  constructor(options?: StreamingSTTSessionOptions) {
    this.#onInterim = options?.onInterim;
    this.#onFinal = options?.onFinal;
    this.#onEndOfTurn = options?.onEndOfTurn;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#aborted) return;
    this.#totalBytes += chunk.byteLength;
    this.#onInterim?.(`hearing ${this.#totalBytes} bytes`);

    if (this.#totalBytes >= 20000 && !this.#eotFired) {
      this.#eotFired = true;
      const transcript = `eot input (${this.#totalBytes} bytes)`;
      this.#onFinal?.(transcript);
      this.#onEndOfTurn?.(transcript);
    }
  }

  async finish(): Promise<string> {
    if (this.#aborted) return "";
    return `eot input (${this.#totalBytes} bytes)`;
  }

  abort(): void {
    this.#aborted = true;
  }
}

class TestEOTStreamingSTT implements StreamingSTTProvider {
  createSession(options?: StreamingSTTSessionOptions): StreamingSTTSession {
    return new TestEOTStreamingSTTSession(options);
  }
}

// --- Test agents ---

const InputBase = withVoiceInput(Agent);

/**
 * Basic batch STT voice input agent.
 * Tracks onTranscript calls and consumer lifecycle invocations for assertions.
 */
export class TestVoiceInputAgent extends InputBase<Record<string, unknown>> {
  static options = { hibernate: false };

  stt = new TestSTT();
  vad = new TestVAD();

  #transcripts: string[] = [];
  #connectCount = 0;
  #closeCount = 0;
  #customMessages: string[] = [];

  onTranscript(text: string, _connection: Connection) {
    this.#transcripts.push(text);
  }

  // Consumer lifecycle methods — these should be called by the mixin wrapper
  onConnect(connection: Connection) {
    this.#connectCount++;
    // Verify we can still use Agent's connection
    console.log(`[TestVoiceInput] consumer onConnect: ${connection.id}`);
  }

  onClose(connection: Connection) {
    this.#closeCount++;
    console.log(`[TestVoiceInput] consumer onClose: ${connection.id}`);
  }

  onMessage(connection: Connection, message: WSMessage) {
    // This should only receive non-voice messages
    if (typeof message === "string") {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }

      switch (parsed.type) {
        case "_get_state":
          connection.send(
            JSON.stringify({
              type: "_state",
              transcripts: this.#transcripts,
              connectCount: this.#connectCount,
              closeCount: this.#closeCount,
              customMessages: this.#customMessages
            })
          );
          break;
        case "_custom":
          this.#customMessages.push(parsed.data as string);
          connection.send(JSON.stringify({ type: "_ack", command: "_custom" }));
          break;
      }
    }
  }
}

/**
 * Streaming STT voice input agent.
 */
export class TestStreamingVoiceInputAgent extends InputBase<
  Record<string, unknown>
> {
  static options = { hibernate: false };

  streamingStt = new TestStreamingSTT();

  #transcripts: string[] = [];

  onTranscript(text: string, _connection: Connection) {
    this.#transcripts.push(text);
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (parsed.type === "_get_state") {
        connection.send(
          JSON.stringify({
            type: "_state",
            transcripts: this.#transcripts
          })
        );
      }
    }
  }
}

/**
 * EOT-capable streaming STT voice input agent.
 */
export class TestEotVoiceInputAgent extends InputBase<Record<string, unknown>> {
  static options = { hibernate: false };

  streamingStt = new TestEOTStreamingSTT();

  #transcripts: string[] = [];

  onTranscript(text: string, _connection: Connection) {
    this.#transcripts.push(text);
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (parsed.type === "_get_state") {
        connection.send(
          JSON.stringify({
            type: "_state",
            transcripts: this.#transcripts
          })
        );
      }
    }
  }
}

/**
 * Voice input agent that rejects calls via beforeCallStart.
 */
export class TestRejectCallVoiceInputAgent extends InputBase<
  Record<string, unknown>
> {
  static options = { hibernate: false };

  stt = new TestSTT();

  beforeCallStart(_connection: Connection): boolean {
    return false;
  }
}
