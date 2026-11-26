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

import { reportDelivery } from "../dynamic-agents/unlisted-sockets";
import { WEBSOCKET_MESSAGE_BYTES } from "../internal/platform-limits";
import { fitsOutboundFrame } from "../websockets/frame-limit";
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
  /**
   * The connections a broadcast reaches: the same objects the host's
   * message and resume handlers receive for each socket, since the end
   * ledger keys by object (an Agent's `getConnections()` does; measured on
   * a deployment).
   */
  connections(): Iterable<{ readonly id: string }>;
  /**
   * Whether a broadcast now also reaches sockets {@link connections} does
   * not list (a sub-agent during its start, whose broadcast the root sends
   * to every socket it accepted for it).
   */
  reachesUnlisted?(): boolean;
  /**
   * Whether the host's broadcast is watched beyond the tabs it lists (an
   * agent-tool run in flight, a subclass that overrides `broadcast`), so a
   * frame is sent even with no tab to read it.
   */
  observed?(): boolean;
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
 * Which sockets were sent each recent request's end, so a socket is sent it
 * once (`OneTerminalPerRequest`): a stop, a resume and a recovery's
 * broadcast can each want to tell it. Keyed by the connection object, not
 * its id: a tab that reconnects keeps its id on a new socket, and that
 * socket was told nothing. Bounded to the newest requests; an older one
 * that comes up again is sent its end again. In memory.
 *
 * @internal
 */
export class EndedRequests {
  static readonly MAX = 64;
  /** By request: the sockets it was sent to. */
  readonly #ended = new Map<string, WeakSet<object>>();

  /**
   * By request: when its end was broadcast, and the ids it left out. A
   * facet broadcasting during its start reaches, through the root, sockets
   * it does not know yet, so no object is noted for them.
   */
  readonly #broadcast = new Map<string, { at: number; without: Set<string> }>();

  /**
   * Whether `connection` was sent the end of `requestId`: noted for it, or
   * broadcast after (strictly) the root accepted it (a sub-agent's socket, whose
   * `acceptedAt` the root stamps) and not left out.
   */
  has(connection: object, requestId: string): boolean {
    if (this.#ended.get(requestId)?.has(connection)) return true;
    const broadcast = this.#broadcast.get(requestId);
    const { acceptedAt, id } = connection as {
      acceptedAt?: unknown;
      id?: unknown;
    };
    return (
      broadcast !== undefined &&
      typeof acceptedAt === "number" &&
      // Strictly before: `Date.now()` advances only at I/O, so an accept
      // in the broadcast's millisecond may have come after it. A miss here
      // costs a duplicate end; a wrong hit would cost the tab its end.
      acceptedAt < broadcast.at &&
      !(typeof id === "string" && broadcast.without.has(id))
    );
  }

  /**
   * The root sent the broadcast end of `requestId` at `sentAt` (its clock):
   * later than this facet handed it over when the root sent it behind a
   * socket's connect.
   */
  delivered(requestId: string, sentAt: number): void {
    const broadcast = this.#broadcast.get(requestId);
    if (broadcast) broadcast.at = sentAt;
  }

  /** The end of `requestId` was broadcast to every socket but `without`. */
  broadcast(requestId: string, without: readonly string[]): void {
    this.#broadcast.delete(requestId);
    this.#broadcast.set(requestId, {
      at: Date.now(),
      without: new Set(without)
    });
    if (this.#broadcast.size > EndedRequests.MAX) {
      const oldest = this.#broadcast.keys().next().value;
      if (oldest !== undefined) this.#broadcast.delete(oldest);
    }
  }

  /** `connection` was sent the end of `requestId`. */
  note(connection: object, requestId: string): void {
    let to = this.#ended.get(requestId);
    if (!to) {
      to = new WeakSet();
      this.#ended.set(requestId, to);
      if (this.#ended.size > EndedRequests.MAX) {
        const oldest = this.#ended.keys().next().value;
        if (oldest !== undefined) this.#ended.delete(oldest);
      }
    }
    to.add(connection);
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
    const without = [...exclude, ...this.options.resuming];
    const ends = endedRequestOf(ready);
    if (ends !== undefined) {
      // A socket is told a request's end once.
      const left = new Set(without);
      let listed = false;
      for (const connection of this.options.connections()) {
        if (left.has(connection.id)) continue;
        if (this.ended.has(connection, ends)) {
          without.push(connection.id);
        } else {
          this.ended.note(connection, ends);
          listed = true;
        }
      }
      // A broadcast that goes out reaches, through the root, sockets it
      // accepted that nobody here lists yet. One goes out when a listed
      // socket not told yet gets it, or when the host says it reaches unlisted ones (a
      // starting sub-agent); a sub-agent that knows its sockets skips one
      // with no listed recipient.
      if (listed || this.options.reachesUnlisted?.()) {
        this.ended.broadcast(ends, without);
        // When the root sent it, if it went through the root: an accept
        // before that, even after this call, got the frame.
        const text = frameText(ready);
        if (text === undefined) return;
        reportDelivery(
          (sentAt) => this.ended.delivered(ends, sentAt),
          () => this.options.broadcast(text, without)
        );
        this.#record(ready);
        return;
      }
    }
    // With nobody to read it, the frame is not serialized (#2724). A
    // terminal is still recorded, for a tab that comes back.
    if (!this.#reaches(without)) {
      this.#record(ready);
      return;
    }
    const text = frameText(ready);
    if (text === undefined) return;
    this.options.broadcast(text, without);
    this.#record(ready);
  }

  /**
   * Whether a broadcast that leaves out `without` has a reader: a listed
   * socket outside it, sockets the host reaches unlisted, or a host whose
   * broadcast is observed.
   */
  #reaches(without: readonly string[]): boolean {
    if (this.options.observed?.() || this.options.reachesUnlisted?.()) {
      return true;
    }
    const left = new Set(without);
    for (const connection of this.options.connections()) {
      if (!left.has(connection.id)) return true;
    }
    return false;
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
    const without = this.options.listsReachResumingTabs
      ? [...exclude]
      : [...exclude, ...this.options.resuming];
    if (!this.#reaches(without)) return;
    const text = frameText(this.messagesFrame(messages));
    if (text === undefined) return;
    this.options.broadcast(text, without);
  }

  /** Send `frame` to one tab. A closed socket is ignored. */
  send(connection: ChatFrameConnection, frame: ChatFrame): void {
    const ready = this.#prepare(frame);
    const text = frameText(ready);
    if (text === undefined) return;
    const ends = endedRequestOf(ready);
    if (ends !== undefined) {
      if (this.ended.has(connection, ends)) return;
      this.ended.note(connection, ends);
    }
    try {
      connection.send(text);
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

/**
 * A chat frame's JSON, or `undefined` when it is over the SDK's WebSocket
 * message limit (`WEBSOCKET_MESSAGE_BYTES`, 1 KiB under what production
 * delivers). Production drops a larger message without telling either side,
 * so such a frame is not sent and the drop is logged instead. Only the
 * message list can get that large: it carries the transcript.
 *
 * @internal
 */
export function frameText(frame: {
  readonly type?: unknown;
}): string | undefined {
  const text = JSON.stringify(frame);
  if (fitsOutboundFrame(text)) return text;
  console.error(
    `[agents/chat] Not sending a ${String(frame.type)} frame of ${text.length} characters: it is over the ${WEBSOCKET_MESSAGE_BYTES}-byte limit for one WebSocket message, so the client keeps the list it has. The transcript is too large to send whole; in Think and AIChatAgent, a lower hydrationByteBudget keeps it under the limit.`
  );
  return undefined;
}
