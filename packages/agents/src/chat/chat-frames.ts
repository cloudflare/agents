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
 * What {@link ChatFrames} needs from its host.
 *
 * @internal
 */
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
  /**
   * Whether message lists also go to tabs waiting on a resume ack. `Think`
   * sends them (its lists never carry the in-flight reply); `AIChatAgent`
   * withholds them, like every other frame.
   */
  listsReachResumingTabs?: boolean;
}

/**
 * Which tabs were sent each recent request's end, so a tab is sent it once
 * (`OneTerminalPerRequest`): a stop, a resume and a recovery's broadcast
 * can each want to tell it. Bounded to the newest requests; an older one
 * that comes up again is sent its end again. In memory: a tab that
 * reconnects after a hibernation is a new connection anyway.
 *
 * @internal
 */
export class EndedRequests {
  static readonly MAX = 64;
  /**
   * By request: the tabs it was sent to, and, once it was broadcast, the
   * tabs that broadcast left out (a tab waiting on its resume ack).
   */
  readonly #ended = new Map<
    string,
    { to: Set<string>; broadcastExcept?: Set<string> }
  >();

  /** Whether `connectionId` was sent the end of `requestId`. */
  has(connectionId: string, requestId: string): boolean {
    const entry = this.#ended.get(requestId);
    if (!entry) return false;
    return (
      entry.to.has(connectionId) ||
      (entry.broadcastExcept !== undefined &&
        !entry.broadcastExcept.has(connectionId))
    );
  }

  /**
   * The tabs a broadcast of `requestId`'s end must leave out, besides
   * `without`, or `null` when it was broadcast already: a tab that broadcast
   * left out is told by its resume, not by a second broadcast.
   */
  broadcastWithout(requestId: string, without: string[]): string[] | null {
    const entry = this.#entry(requestId);
    if (entry.broadcastExcept !== undefined) return null;
    entry.broadcastExcept = new Set(without);
    return [...without, ...entry.to];
  }

  /** `connectionId` was sent the end of `requestId`. */
  note(connectionId: string, requestId: string): void {
    this.#entry(requestId).to.add(connectionId);
  }

  #entry(requestId: string) {
    let entry = this.#ended.get(requestId);
    if (!entry) {
      entry = { to: new Set() };
      this.#ended.set(requestId, entry);
      if (this.#ended.size > EndedRequests.MAX) {
        const oldest = this.#ended.keys().next().value;
        if (oldest !== undefined) this.#ended.delete(oldest);
      }
    }
    return entry;
  }
}

/** The request a frame ends, if it is a terminal: a `done` that is not "recovering". */
export function endedRequestOf(frame: ChatFrame): string | undefined {
  const fields = frame as {
    type?: unknown;
    id?: unknown;
    done?: unknown;
    outcome?: unknown;
  };
  return fields.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE &&
    typeof fields.id === "string" &&
    fields.done === true &&
    fields.outcome !== "recovering"
    ? fields.id
    : undefined;
}

/** @internal */
export class ChatFrames {
  /** Which tabs were sent which request's end. */
  readonly ended = new EndedRequests();

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
    let without = [...exclude, ...this.options.resuming];
    const ends = endedRequestOf(ready);
    if (ends !== undefined) {
      // A tab is told a request's end once.
      const skip = this.ended.broadcastWithout(ends, without);
      if (skip === null) return;
      without = skip;
    }
    this.options.broadcast(JSON.stringify(ready), without);
    this.#record(ready);
  }

  /**
   * The message list frame for `messages`: the transcript, then the messages
   * waiting requests hold, named in `queuedMessageIds`.
   */
  messagesFrame<TMessage extends { id: string }>(
    messages: ReadonlyArray<TMessage>,
    extra?: Readonly<Record<string, unknown>>
  ): ChatFrame {
    return {
      type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
      ...this.options.clientView(messages),
      ...extra
    };
  }

  /** Send the message list for `messages` to every tab except `exclude`. */
  broadcastMessages<TMessage extends { id: string }>(
    messages: ReadonlyArray<TMessage>,
    exclude: readonly string[] = []
  ): void {
    this.options.broadcast(
      JSON.stringify(this.messagesFrame(messages)),
      this.options.listsReachResumingTabs
        ? [...exclude]
        : [...exclude, ...this.options.resuming]
    );
  }

  /** Send `frame` to one tab. A closed socket is ignored. */
  send(connection: ChatFrameConnection, frame: ChatFrame): void {
    const ready = this.#prepare(frame);
    const ends = endedRequestOf(ready);
    if (ends !== undefined) {
      if (this.ended.has(connection.id, ends)) return;
      this.ended.note(connection.id, ends);
    }
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
