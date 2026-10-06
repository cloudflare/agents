/**
 * Live events for one session, in the AI SDK's vocabulary, and the
 * projection of them onto the shared harness interface's watch.
 */
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  OperationStatus,
  SessionEvent,
  SessionState,
  SessionWatch
} from "../../experimental/channels/harness";

/**
 * Something that happened in a session, as the AI SDK describes it.
 *
 * @experimental
 */
export type ThinkSessionEvent =
  | { readonly type: "operation"; readonly status: OperationStatus }
  | {
      readonly type: "run-start";
      readonly operationId: string;
      /** Whether the operation continues an assistant message already persisted. */
      readonly continuation: boolean;
    }
  | { readonly type: "run-end"; readonly operationId: string }
  /**
   * A streamed chunk of the operation's assistant message. Chunks of one
   * model call continue the message as persisted before that call.
   */
  | {
      readonly type: "chunk";
      readonly operationId: string;
      readonly chunk: UIMessageChunk;
    }
  /** A message was persisted; it replaces any message with its id. */
  | {
      readonly type: "message";
      readonly message: UIMessage;
      /** The operation that wrote it. */
      readonly operationId?: string;
    }
  /** The session was reset. Messages that follow belong to the new context. */
  | { readonly type: "reset" };

/** A listener for a session's events. @experimental */
export type ThinkSessionListener = (event: ThinkSessionEvent) => void;

/** A listener for every session's events. @experimental */
export type ThinkHarnessListener = (
  session: string,
  event: ThinkSessionEvent
) => void;

/** Fan-out of session events to listeners, per session. */
export class SessionEvents {
  readonly #listeners = new Map<string, Set<ThinkSessionListener>>();
  readonly #observers = new Set<ThinkHarnessListener>();

  /** Listen to every session. Returns the unsubscribe. */
  observe(listener: ThinkHarnessListener): () => void {
    this.#observers.add(listener);
    return () => {
      this.#observers.delete(listener);
    };
  }

  /** Listen to one session. Returns the unsubscribe. */
  subscribe(session: string, listener: ThinkSessionListener): () => void {
    let listeners = this.#listeners.get(session);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(session, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(session);
    };
  }

  /** Deliver an event to a session's listeners. A throwing listener is logged. */
  emit(session: string, event: ThinkSessionEvent): void {
    for (const observer of this.#observers) {
      try {
        observer(session, event);
      } catch (error) {
        console.error("A ThinkHarness observer failed", error);
      }
    }
    for (const listener of this.#listeners.get(session) ?? []) {
      try {
        listener(event);
      } catch (error) {
        console.error("A ThinkHarness session listener failed", error);
      }
    }
  }
}

/** One watch: events queue until `start`, then reach the listener in order. */
export class Watcher implements SessionWatch {
  readonly closed: Promise<void>;
  readonly state: SessionState;
  #close: () => void = () => {};
  #listener: ((events: readonly SessionEvent[]) => Promise<void>) | undefined;
  readonly #queue: SessionEvent[][] = [];
  readonly #onStop: () => void;
  #draining = false;
  #stopped = false;

  constructor(state: SessionState, onStop: () => void) {
    this.state = state;
    this.#onStop = onStop;
    this.closed = new Promise((resolve) => {
      this.#close = resolve;
    });
  }

  /** Start delivering queued and later events. */
  start(listener: (events: readonly SessionEvent[]) => Promise<void>): void {
    this.#listener = listener;
    void this.#drain();
  }

  /** Stop the watch. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#onStop();
    this.#close();
  }

  /** Queue events for the listener. */
  push(events: SessionEvent[]): void {
    if (this.#stopped || events.length === 0) return;
    this.#queue.push(events);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (!this.#listener || this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const events = this.#queue.shift();
        if (!events || this.#stopped) return;
        try {
          await this.#listener(events);
        } catch (error) {
          console.error("A ThinkHarness session watcher failed", error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}
