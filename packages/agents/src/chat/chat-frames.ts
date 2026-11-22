/**
 * The one place a chat host sends frames to its tabs. Both `AIChatAgent`
 * and `Think` send through it, so the rules below hold the same in both:
 *
 * - A terminal response frame (`done` or `error`) names the user messages
 *   its request came from (`messageIds`, #2280).
 * - A message list ends with the messages waiting requests hold, named in
 *   `queuedMessageIds`.
 * - A tab waiting on its resume ack gets no live response frames: it gets
 *   them from the replay once it acks.
 * - A terminal response frame is recorded after it is sent, so a tab that
 *   was away gets it when it resumes (`recent-terminals.ts`).
 */

import { CHAT_MESSAGE_TYPES } from "./protocol";
import { withOriginMessageIds } from "./origin-message-ids";
import {
  recordRecentChatTerminal,
  type RecentTerminalsKv
} from "./recent-terminals";

/**
 * A frame sent to tabs.
 *
 * @internal
 */
export type ChatFrame = Readonly<Record<string, unknown>>;

/**
 * A socket a frame can be sent to directly.
 *
 * @internal
 */
export interface ChatFrameConnection {
  readonly id: string;
  send(message: string): void;
}

/**
 * One chat frame in the chat event log. `without` names the connections
 * the frame skips (a sender that already holds what it says); a following
 * tab drops an event that names its own connection id.
 *
 * @internal
 */
export type ChatLogEvent = {
  readonly frame: ChatFrame;
  readonly without?: readonly string[];
};

/**
 * The event log the host declared for chat frames (`cf_chat`). The parts
 * {@link ChatFrames} uses.
 *
 * @internal
 */
export interface ChatFrameLog {
  publish(event: ChatLogEvent): number;
  batch(): { append(event: ChatLogEvent): number; close(): void };
  followerIds(): string[];
}

/** The name of the chat event log. @internal */
export const CHAT_EVENT_LOG = "cf_chat";

/**
 * What {@link ChatFrames} needs from its host.
 *
 * @internal
 */
export interface ChatFramesOptions {
  /**
   * The chat event log. Every broadcast frame goes into it: response
   * chunks through one batch per request, everything else through
   * `publish`. Connections that do not follow it get frames the old way.
   */
  log?: ChatFrameLog;
  /** Send to every connection except the `without` ids. */
  broadcast(message: string, without: string[]): void;
  /** Where recent terminal frames are recorded. */
  kv: RecentTerminalsKv;
  /** Connections that were told a stream resumes and have not acked yet. */
  resuming: ReadonlySet<string>;
  /** Origin ids stored with the request's stream. */
  storedOriginIds(requestId: string): string[] | undefined;
  /** Origin ids of the recovery chain running now, if any. */
  recoveryOriginIds(): string[] | undefined;
  /** The message list a tab is sent (`ChatTurns.clientView`). */
  clientView<TMessage extends { id: string }>(
    messages: ReadonlyArray<TMessage>
  ): { messages: TMessage[]; queuedMessageIds?: string[] };
}

/** @internal */
export class ChatFrames {
  /**
   * Origin ids of the socket requests being handled, by request id. After
   * a request is handled (or after a restart) its stream holds them.
   */
  readonly requestOrigins = new Map<string, string[]>();

  constructor(private readonly options: ChatFramesOptions) {}

  /** The user message ids `requestId` came from. */
  originIds(requestId: string): string[] | undefined {
    return (
      this.requestOrigins.get(requestId) ??
      this.options.storedOriginIds(requestId) ??
      this.options.recoveryOriginIds()
    );
  }

  /** Response chunk batches of the requests streaming now. */
  readonly #batches = new Map<
    string,
    { append(event: ChatLogEvent): number; close(): void }
  >();

  /** Send `frame` to every tab except `exclude` and resuming tabs. */
  broadcast(frame: ChatFrame, exclude: readonly string[] = []): void {
    const ready = this.#prepare(frame);
    const log = this.options.log;
    const logged = log ? this.#publish(log, ready, exclude) : false;
    // Sent the old way to tabs not following the log. `inLog` lets a tab
    // that is about to follow (its subscribe not read yet) drop the copy:
    // the log's replay or snapshot carries the frame.
    const raw = logged ? { ...ready, inLog: true } : ready;
    this.options.broadcast(JSON.stringify(raw), [
      ...exclude,
      ...this.options.resuming,
      ...(log && logged ? log.followerIds() : [])
    ]);
    this.#record(ready);
  }

  /**
   * Put a broadcast frame in the log, keeping one batch per request.
   * Returns false when the log refused it (an event over the size cap):
   * the frame then goes to following tabs the old way too, and a tab that
   * resyncs later gets its effect from the snapshot.
   */
  #publish(
    log: ChatFrameLog,
    frame: ChatFrame,
    exclude: readonly string[]
  ): boolean {
    try {
      this.#append(log, frame, exclude);
      return true;
    } catch (error) {
      console.error("[ChatFrames] chat event log refused a frame:", error);
      return false;
    }
  }

  #append(log: ChatFrameLog, frame: ChatFrame, exclude: readonly string[]) {
    const event: ChatLogEvent =
      exclude.length > 0 ? { frame, without: [...exclude] } : { frame };
    const fields = frame as {
      type?: unknown;
      id?: unknown;
      done?: unknown;
      error?: unknown;
    };
    if (
      fields.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE ||
      typeof fields.id !== "string"
    ) {
      log.publish(event);
      return;
    }
    if (!fields.done && !fields.error) {
      let batch = this.#batches.get(fields.id);
      if (!batch) {
        batch = log.batch();
        this.#batches.set(fields.id, batch);
      }
      batch.append(event);
      return;
    }
    // A terminal frame: written at once (after anything buffered), and the
    // request's batch ends.
    log.publish(event);
    this.#batches.get(fields.id)?.close();
    this.#batches.delete(fields.id);
  }

  /** Send `frame` to one tab. A closed socket is ignored. */
  send(connection: ChatFrameConnection, frame: ChatFrame): void {
    const ready = this.#prepare(frame);
    try {
      connection.send(JSON.stringify(ready));
    } catch {
      // The connection closed before the server could answer.
    }
    this.#record(ready);
  }

  /**
   * End a request that never got a turn (skipped or cancelled while it
   * waited). The tab that sent it is told; no other tab was shown it. A
   * request replayed after a reset has no connection, and the tab that
   * sent it may be any of them, so every tab is told.
   */
  endUnstarted(
    connection: ChatFrameConnection | null,
    requestId: string,
    outcome: "skipped" | "aborted"
  ): void {
    const frame = {
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      id: requestId,
      body: "",
      done: true,
      outcome
    };
    if (connection) {
      this.send(connection, frame);
    } else {
      this.broadcast(frame);
    }
  }

  #prepare(frame: ChatFrame): ChatFrame {
    const fields = frame as {
      type?: unknown;
      id?: unknown;
      done?: unknown;
      error?: unknown;
      messages?: unknown;
    };
    if (
      fields.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE &&
      typeof fields.id === "string" &&
      (fields.done || fields.error)
    ) {
      return withOriginMessageIds(frame, this.originIds(fields.id));
    }
    if (
      fields.type === CHAT_MESSAGE_TYPES.CHAT_MESSAGES &&
      Array.isArray(fields.messages)
    ) {
      const view = this.options.clientView(
        fields.messages as Array<{ id: string }>
      );
      if (view.queuedMessageIds) return { ...frame, ...view };
    }
    return frame;
  }

  /** After the send: a failed record must not cost a tab its frame. */
  #record(frame: ChatFrame): void {
    if (frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) {
      recordRecentChatTerminal(this.options.kv, frame);
    }
  }
}
