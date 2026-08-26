import { Agent, type Connection, type WSMessage } from "agents";
import { VoiceProviderError } from "../../errors";
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
  #onInterim: TranscriberSessionOptions["onInterim"];
  #onUtterance: TranscriberSessionOptions["onUtterance"];
  #onFatalError: TranscriberSessionOptions["onFatalError"];
  #utteranceThreshold: number;

  constructor(options?: TranscriberSessionOptions, utteranceThreshold = 20000) {
    this.#onInterim = options?.onInterim;
    this.#onUtterance = options?.onUtterance;
    this.#onFatalError = options?.onFatalError;
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

  reportFatalError(error: Error): void {
    this.#onFatalError?.(error);
  }

  close(): void {
    this.#closed = true;
  }
}

class RejectingReadyTranscriber implements Transcriber {
  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    const failure = new VoiceProviderError("provider startup failed", {
      code: "provider_unavailable"
    });
    return {
      feed() {},
      waitUntilReady: () =>
        new Promise<void>((_resolve, reject) => {
          queueMicrotask(() => {
            options?.onFatalError?.(failure);
            reject(failure);
          });
        }),
      close() {}
    };
  }
}

class DetachedFailingTranscriber implements Transcriber {
  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    let closed = false;
    queueMicrotask(() => {
      if (closed) return;
      options?.onFatalError?.(
        new VoiceProviderError("detached provider failed to connect", {
          code: "socket_upgrade_failed"
        })
      );
    });
    return {
      feed() {},
      close() {
        closed = true;
      }
    };
  }
}

class TestTranscriber implements Transcriber {
  #utteranceThreshold: number;
  sessions: TestTranscriberSession[] = [];

  constructor(utteranceThreshold = 20000) {
    this.#utteranceThreshold = utteranceThreshold;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    const session = new TestTranscriberSession(
      options,
      this.#utteranceThreshold
    );
    this.sessions.push(session);
    return session;
  }
}

// --- Test agents ---

const InputBase = withVoiceInput(Agent);
const DiagnosticInputBase = withVoiceInput(Agent, {
  diagnostics: { browserConsole: true }
});

/**
 * Continuous STT voice input agent with test transcriber.
 * Tracks onTranscript calls and consumer lifecycle invocations for assertions.
 */
export class TestVoiceInputAgent extends InputBase {
  transcriber = new TestTranscriber();

  #transcripts: string[] = [];
  #connectCount = 0;
  #closeCount = 0;
  #callStartCount = 0;
  #callEndCount = 0;
  #customMessages: string[] = [];
  #beforeCallStartMode: "allow" | "pending" = "allow";
  #resolveBeforeCallStart: ((allowed: boolean) => void) | null = null;
  #onCallStartShouldThrow = false;
  #transcriberMode: "default" | "detached_failure" | "reject_ready" = "default";

  createTranscriber(_connection: Connection): Transcriber | null {
    if (this.#transcriberMode === "detached_failure") {
      return new DetachedFailingTranscriber();
    }
    if (this.#transcriberMode === "reject_ready") {
      return new RejectingReadyTranscriber();
    }
    return null;
  }

  onTranscript(text: string, _connection: Connection) {
    this.#transcripts.push(text);
  }

  beforeCallStart(connection: Connection): boolean | Promise<boolean> {
    if (this.#beforeCallStartMode === "allow") return true;

    connection.send(JSON.stringify({ type: "_startup_pending" }));
    return new Promise<boolean>((resolve) => {
      this.#resolveBeforeCallStart = resolve;
    });
  }

  onCallStart(_connection: Connection) {
    this.#callStartCount++;
    if (this.#onCallStartShouldThrow) {
      throw new Error("onCallStart failed");
    }
  }

  onCallEnd(_connection: Connection) {
    this.#callEndCount++;
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
              callStart: this.#callStartCount,
              callEnd: this.#callEndCount,
              customMessages: this.#customMessages
            })
          );
          break;
        case "_set_before_call_start":
          if (parsed.value === "pending") {
            this.#beforeCallStartMode = "pending";
          } else if (parsed.value === "allow") {
            this.#beforeCallStartMode = "allow";
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_resolve_before_call_start": {
          const resolve = this.#resolveBeforeCallStart;
          this.#resolveBeforeCallStart = null;
          resolve?.(parsed.value !== false);
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        }
        case "_set_on_call_start_throw":
          this.#onCallStartShouldThrow = parsed.value === true;
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_use_detached_failing_transcriber":
          this.#transcriberMode = "detached_failure";
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_use_rejecting_ready_transcriber":
          this.#transcriberMode = "reject_ready";
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_report_transcriber_fatal_at":
          if (typeof parsed.index === "number") {
            this.transcriber.sessions[parsed.index]?.reportFatalError(
              new Error(
                (parsed.error as { message?: string } | undefined)?.message ??
                  "transcriber failed"
              )
            );
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
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

export class TestDiagnosticVoiceInputAgent extends DiagnosticInputBase {
  transcriber = new TestTranscriber();

  onTranscript(_text: string, _connection: Connection): void {}
}

/**
 * Voice input agent that rejects calls via beforeCallStart.
 */
export class TestRejectCallVoiceInputAgent extends InputBase {
  transcriber = new TestTranscriber();

  beforeCallStart(_connection: Connection): boolean {
    return false;
  }
}
