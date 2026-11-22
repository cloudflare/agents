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

/** A frame sent to tabs. */
export type ChatFrame = Readonly<Record<string, unknown>>;

/** A socket a frame can be sent to directly. */
export interface ChatFrameConnection {
  readonly id: string;
  send(message: string): void;
}

/** What {@link ChatFrames} needs from its host. */
export interface ChatFramesOptions {
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

  /** Send `frame` to every tab except `exclude` and resuming tabs. */
  broadcast(frame: ChatFrame, exclude: readonly string[] = []): void {
    const ready = this.#prepare(frame);
    this.options.broadcast(JSON.stringify(ready), [
      ...exclude,
      ...this.options.resuming
    ]);
    this.#record(ready);
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
