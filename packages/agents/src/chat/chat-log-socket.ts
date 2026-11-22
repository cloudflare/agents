/**
 * The socket `useAgentChat` and its transport talk to: the agent's socket
 * with chat frames taken from the chat event log (`cf_chat`) instead of
 * from live broadcasts.
 *
 * - Frames in the log are re-dispatched as ordinary `message` events, in
 *   log order, exactly once: after a reconnect the log replays what the tab
 *   missed after its cursor, terminal frames included.
 * - A drop and reconnect is not shown to the chat code (no `close`/`open`),
 *   because nothing needs resuming: the replay continues every stream where
 *   it stopped. Only a final close (no reconnect coming) is passed on.
 * - The resume handshake the chat code still speaks keeps its server side
 *   for the decision (a stream to resume, a turn not streaming yet, or
 *   nothing), but the ack is answered here: with that stream's chunks so
 *   far, from the log, as replay frames. The server no longer replays.
 * - A new tab, or one whose cursor cannot be replayed, gets the snapshot as
 *   a `cf_agent_chat_messages` frame plus the in-flight stream.
 *
 * Until the server answers the subscribe, and for good against a server
 * without the log (the subscribe is refused), everything passes through
 * unchanged.
 *
 * @internal Sibling-package support, not a public API.
 */

import { followEventLog, type EventLogSubscription } from "../event-log-client";
import { CHAT_EVENT_LOG, type ChatLogEvent } from "./chat-frames";
import type { ChatLogActiveStream, ChatLogSnapshot } from "./chat-log";
import { CHAT_MESSAGE_TYPES } from "./protocol";

/** The agent socket a {@link ChatLogSocket} wraps. @internal */
export interface ChatLogSocketAgent {
  readonly readyState: number;
  send(data: string): boolean | void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

type ActiveStream = {
  requestId: string;
  continuation: boolean;
  messageId?: string;
  chunks: Array<{ body: string; seq?: number }>;
};

type Mode = "pending" | "log" | "legacy";

const wrapped = new WeakMap<ChatLogSocketAgent, ChatLogSocket>();

/** The one chat socket for an agent socket. @internal */
export function chatLogSocketFor(agent: ChatLogSocketAgent): ChatLogSocket {
  let socket = wrapped.get(agent);
  if (!socket) {
    socket = new ChatLogSocket(agent);
    wrapped.set(agent, socket);
  }
  return socket;
}

/** @internal */
export class ChatLogSocket extends EventTarget {
  readonly #agent: ChatLogSocketAgent;
  #mode: Mode = "pending";
  /** Whether the log answered since the socket last opened. */
  #synced = false;
  #resynced = false;
  /** Resume acks waiting for the log to catch up after a (re)connect. */
  #waitingAcks: unknown[] = [];
  #active: ActiveStream | null = null;
  /** Hooks using this socket; the log is followed while there is one. */
  #users = 0;
  #subscription: EventLogSubscription | undefined;

  constructor(agent: ChatLogSocketAgent) {
    super();
    this.#agent = agent;
    agent.addEventListener("message", (event) =>
      this.#onRaw(event as MessageEvent)
    );
    agent.addEventListener("open", () => {
      if (this.#mode !== "log") this.dispatchEvent(new Event("open"));
    });
    agent.addEventListener("close", (event) => {
      this.#synced = false;
      const final =
        (agent as { shouldReconnect?: boolean }).shouldReconnect === false;
      if (this.#mode !== "log" || final) {
        this.dispatchEvent(new CloseEvent("close", event as CloseEventInit));
      }
    });
  }

  /**
   * A hook starts using this socket: follow the log if nothing did. Called
   * from an effect, so a render that never commits leaves no subscription.
   */
  retain(): void {
    this.#users += 1;
    if (this.#subscription) return;
    this.#subscription = followEventLog<ChatLogEvent, ChatLogSnapshot>(
      this.#agent,
      CHAT_EVENT_LOG,
      {
        onResync: (snapshot) => this.#onResync(snapshot ?? { messages: [] }),
        onEvent: (event, _seq, info) => this.#onEvent(event, info.replay),
        onSynced: () => this.#ready(),
        onError: () => this.#legacy()
      }
    );
  }

  /** A hook stopped using this socket: the last one stops following. */
  release(): void {
    this.#users = Math.max(0, this.#users - 1);
    if (this.#users > 0 || !this.#subscription) return;
    this.#subscription.close();
    this.#subscription = undefined;
    this.#mode = "pending";
    this.#synced = false;
    this.#resynced = false;
    this.#active = null;
    this.#waitingAcks = [];
  }

  /** Listeners typed for the `MessageEvent`s this socket dispatches. */
  override addEventListener(
    type: string,
    listener:
      | ((event: MessageEvent) => void)
      | EventListenerOrEventListenerObject
      | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(
      type,
      listener as EventListenerOrEventListenerObject | null,
      options
    );
  }

  override removeEventListener(
    type: string,
    listener:
      | ((event: MessageEvent) => void)
      | EventListenerOrEventListenerObject
      | null,
    options?: boolean | EventListenerOptions
  ): void {
    super.removeEventListener(
      type,
      listener as EventListenerOrEventListenerObject | null,
      options
    );
  }

  get readyState(): number {
    return this.#agent.readyState;
  }

  /** The connection id the server knows this socket by. */
  get _pk(): string | undefined {
    return (this.#agent as { _pk?: string })._pk;
  }

  send(data: string): boolean | void {
    if (this.#mode === "log") {
      const frame = parseFrame(data);
      if (frame?.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK) {
        if (this.#synced) this.#answerAck(frame.id);
        else this.#waitingAcks.push(frame.id);
        // The server sends nothing back to a follower's ack; it only ends a
        // stream whose producer is gone.
      }
    }
    return this.#agent.send(data);
  }

  #onRaw(event: MessageEvent): void {
    const { data } = event;
    if (typeof data === "string" && this.#mode !== "legacy") {
      const type = data.includes('"cf_agent_') ? parseFrame(data)?.type : "";
      if (typeof type === "string" && type.startsWith("cf_agent_log_")) return;
      // A broadcast this socket got before the server read its subscribe:
      // the log replays it, or the snapshot holds it.
      if (
        this.#mode === "log" &&
        data.includes('"inLog":true') &&
        parseFrame(data)?.inLog === true
      ) {
        return;
      }
    }
    this.#dispatch(data);
  }

  #onEvent(event: ChatLogEvent, replay: boolean): void {
    if (!("frame" in event)) {
      // The log could not hold a frame: what this tab built may miss it.
      if (replay) this.#subscription?.resync();
      return;
    }
    const own = this._pk;
    if (event.only && (own === undefined || !event.only.includes(own))) {
      return;
    }
    this.#track(event.frame);
    if (own !== undefined && event.without?.includes(own)) return;
    // A terminal frame caught up from the cursor reads as replayed, as it
    // did from the old resume replay (`onTurnEnd`'s `replay`).
    const frame =
      replay &&
      event.frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE &&
      (event.frame.done === true || event.frame.error === true)
        ? { ...event.frame, replay: true }
        : event.frame;
    this.#dispatch(JSON.stringify(frame));
  }

  #onResync(snapshot: ChatLogSnapshot): void {
    if (this.#resynced) {
      // A resync after the first means the tab missed frames it cannot
      // replay. Show the chat code a reconnect, so it settles what it
      // waits on the way it did before the log (its resume probe).
      this.dispatchEvent(new CloseEvent("close", { code: 1006 }));
      this.dispatchEvent(new Event("open"));
    }
    this.#mode = "log";
    this.#active = snapshot.active ? fromSnapshot(snapshot.active) : null;
    this.#dispatchFrame({
      type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
      messages: snapshot.messages,
      ...(snapshot.queuedMessageIds && {
        queuedMessageIds: snapshot.queuedMessageIds
      }),
      connect: true
    });
    if (snapshot.recovering !== undefined) {
      this.#dispatchFrame({
        type: CHAT_MESSAGE_TYPES.CHAT_RECOVERING,
        recovering: true,
        ...(typeof snapshot.recovering === "string" && {
          id: snapshot.recovering
        })
      });
    } else if (this.#resynced) {
      // A later resync replaces state: a recovery it no longer shows ended.
      this.#dispatchFrame({
        type: CHAT_MESSAGE_TYPES.CHAT_RECOVERING,
        recovering: false
      });
    }
    this.#resynced = true;
    this.#ready();
  }

  #ready(): void {
    this.#mode = "log";
    this.#synced = true;
    const acks = this.#waitingAcks;
    this.#waitingAcks = [];
    for (const id of acks) this.#answerAck(id);
  }

  /** The server has no chat log: pass everything through from now on. */
  #legacy(): void {
    this.#mode = "legacy";
  }

  /** Follow the stream in flight, so a resume can be answered from here. */
  #track(frame: Record<string, unknown>): void {
    if (
      frame.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE ||
      typeof frame.id !== "string"
    ) {
      return;
    }
    if (frame.done || frame.error) {
      if (this.#active?.requestId === frame.id) this.#active = null;
      return;
    }
    if (this.#active?.requestId !== frame.id) {
      this.#active = {
        requestId: frame.id,
        continuation: frame.continuation === true,
        ...(typeof frame.messageId === "string" && {
          messageId: frame.messageId
        }),
        chunks: []
      };
    }
    if (typeof frame.body === "string" && frame.body !== "") {
      this.#active.chunks.push({
        body: frame.body,
        ...(typeof frame.seq === "number" && { seq: frame.seq })
      });
    }
  }

  /** Replay the acked stream's chunks so far; the log carries the rest. */
  #answerAck(requestId: unknown): void {
    // Only the stream in flight is replayed from here. Anything else (a
    // request that ended, a recorded error) the server answers.
    const active = this.#active;
    if (!active || active.requestId !== requestId) return;
    const flags = {
      ...(active.continuation && { continuation: true }),
      ...(active.continuation &&
        active.messageId !== undefined && { messageId: active.messageId })
    };
    const frames: Array<Record<string, unknown>> = active.chunks.map(
      (chunk) => ({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: active.requestId,
        body: chunk.body,
        done: false,
        replay: true,
        ...(chunk.seq !== undefined && { seq: chunk.seq }),
        ...flags
      })
    );
    frames.push({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      id: active.requestId,
      body: "",
      done: false,
      replay: true,
      replayComplete: true,
      ...(active.continuation && { continuation: true })
    });
    queueMicrotask(() => {
      for (const frame of frames) this.#dispatchFrame(frame);
    });
  }

  #dispatchFrame(frame: Record<string, unknown>): void {
    this.#dispatch(JSON.stringify(frame));
  }

  #dispatch(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function fromSnapshot(active: ChatLogActiveStream): ActiveStream {
  return {
    requestId: active.requestId,
    continuation: active.continuation,
    ...(active.messageId !== undefined && { messageId: active.messageId }),
    chunks: active.chunks.map((body, index) => ({
      body,
      seq: active.seqBase + index
    }))
  };
}

function parseFrame(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
