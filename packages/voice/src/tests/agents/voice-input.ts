import { Agent, type Connection, type WSMessage } from "agents";
import { withVoiceInput } from "../../voice-input";
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "../../types";

// --- Test transcriber stub ---

/**
 * Deterministic continuous transcriber session for tests.
 * Fires onUtterance every `utteranceThreshold` bytes accumulated.
 * Fires onInterim on every feed() with a running byte count.
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

const InputBase = withVoiceInput(Agent);

/**
 * Continuous STT voice input agent with test transcriber.
 * Tracks onTranscript calls and consumer lifecycle invocations for assertions.
 */
export class TestVoiceInputAgent extends InputBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();

  #transcripts: string[] = [];
  #connectCount = 0;
  #closeCount = 0;
  #customMessages: string[] = [];

  onTranscript(text: string, _connection: Connection) {
    this.#transcripts.push(text);
  }

  onConnect(connection: Connection) {
    this.#connectCount++;
    console.log(`[TestVoiceInput] consumer onConnect: ${connection.id}`);
  }

  onClose(connection: Connection) {
    this.#closeCount++;
    console.log(`[TestVoiceInput] consumer onClose: ${connection.id}`);
  }

  onMessage(connection: Connection, message: WSMessage) {
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
 * Voice input agent that rejects calls via beforeCallStart.
 */
export class TestRejectCallVoiceInputAgent extends InputBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();

  beforeCallStart(_connection: Connection): boolean {
    return false;
  }
}
