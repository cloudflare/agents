import { applyChunks } from "../apply-chunks";
import type {
  ConversationInfo,
  ConversationOperation,
  InboundEvent,
  Participant,
  ResponseChunk,
  TranscriptMessage,
  TurnStatus
} from "../protocol";
import type { ClientFrame, ServerFrame } from "./protocol";

export type WebChannelClientState = {
  connected: boolean;
  /** The conversation this client follows, once connected. */
  conversationId?: string;
  /** Conversation operations this client may send. */
  operations: ConversationOperation[];
  you?: Participant;
  /** The transcript, with the output of running turns applied. */
  messages: TranscriptMessage[];
  /** Turns that are queued, running or awaiting input. */
  turns: TurnStatus[];
  /** The agent's conversations, once listed or pushed. */
  conversations?: ConversationInfo[];
};

/** An inbound event; the client fills in `eventId` when it is left out. */
export type ClientEvent = InboundEvent extends infer E
  ? E extends { eventId: string }
    ? Omit<E, "eventId"> & { eventId?: string }
    : never
  : never;

/** Turn statuses and response output, frame by frame. */
export type WebChannelActivity =
  | { type: "turn"; turn: TurnStatus }
  | {
      type: "chunks";
      responseId: string;
      turnId: string;
      chunks: ResponseChunk[];
    }
  | {
      type: "end";
      responseId: string;
      turnId: string;
      state: "ended" | "interrupted" | "not-found";
    };

type Response = {
  turnId: string;
  extends?: string;
  chunks: ResponseChunk[];
  /** Applied to the transcript until the turn moves past it. */
  shown: boolean;
  ended: boolean;
};

export type WebChannelClientOptions = {
  /**
   * The URL to reconnect to once the client follows another conversation.
   * Default: the gateway's default, `/channels/<route>/<conversation>`.
   */
  followUrl?(url: URL, conversationId: string): URL;
};

/** A browser client for the Web Channel, with reconnects. */
export class WebChannelClient {
  #url: string;
  readonly #followUrl: NonNullable<WebChannelClientOptions["followUrl"]>;
  #conversationId: string | undefined;
  #operations: ConversationOperation[] = [];
  #socket: WebSocket | undefined;
  #closed = false;
  #connected = false;
  /** The reconnect scheduled after a socket closed, until it runs. */
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #you: Participant | undefined;
  #transcript: TranscriptMessage[] = [];
  readonly #turns = new Map<string, TurnStatus>();
  readonly #responses = new Map<string, Response>();
  /** Events not yet acknowledged, sent again after each reconnect. */
  readonly #outbox = new Map<
    string,
    { event: InboundEvent; resolve(): void; reject(error: Error): void }
  >();
  #conversations: ConversationInfo[] | undefined;
  /** List requests waiting for their answer, by request id. */
  readonly #lists = new Map<
    string,
    { resolve(list: ConversationInfo[]): void; reject(error: Error): void }
  >();
  readonly #listeners = new Set<(state: WebChannelClientState) => void>();
  readonly #activity = new Set<(activity: WebChannelActivity) => void>();
  #state: WebChannelClientState = {
    connected: false,
    operations: [],
    messages: [],
    turns: []
  };

  constructor(url: string | URL, options: WebChannelClientOptions = {}) {
    this.#url = String(url);
    this.#followUrl = options.followUrl ?? defaultFollowUrl;
    this.#connect();
  }

  get state(): WebChannelClientState {
    return this.#state;
  }

  /** Calls the listener on every change. Returns the unsubscribe. */
  subscribe(listener: (state: WebChannelClientState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Calls the listener with each turn status, response chunk and response
   * ending as it arrives, including chunks that arrive after the turn has
   * settled. Returns the unsubscribe.
   */
  onActivity(listener: (activity: WebChannelActivity) => void): () => void {
    this.#activity.add(listener);
    return () => this.#activity.delete(listener);
  }

  /** The chunks received so far for a response this client is reading. */
  chunksOf(responseId: string): readonly ResponseChunk[] | undefined {
    return this.#responses.get(responseId)?.chunks;
  }

  /**
   * Resolves once the agent accepts the event, and rejects if it refuses.
   * While disconnected the event waits, and it is sent again after a
   * reconnect until acknowledged; Channels drops repeats by `eventId`.
   * Rejects once the client is closed.
   */
  send(event: ClientEvent): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Closed"));
    const eventId = event.eventId ?? crypto.randomUUID();
    // SAFETY: the same event, with its id filled in.
    const complete = { ...event, eventId } as InboundEvent;
    return new Promise((resolve, reject) => {
      const accepted = () => {
        // Other connections get the message from Channels; this one adds its
        // own once the agent has accepted it.
        if (complete.type === "message") this.#upsert([complete.message]);
        resolve();
      };
      this.#outbox.set(eventId, { event: complete, resolve: accepted, reject });
      if (this.#connected) {
        this.#send({ type: "channels:event", event: complete });
      }
    });
  }

  /** The agent's conversations. Rejects while disconnected or closed. */
  listConversations(): Promise<ConversationInfo[]> {
    if (this.#closed) return Promise.reject(new Error("Closed"));
    if (!this.#connected) return Promise.reject(new Error("Not connected"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.#lists.set(requestId, { resolve, reject });
      this.#send({ type: "channels:list-conversations", requestId });
    });
  }

  /**
   * Follow another conversation: reconnect to it, as after a create or
   * fork. Events still waiting for an ack are rejected, since they were
   * meant for the conversation left behind.
   */
  follow(conversationId: string): void {
    if (this.#closed || conversationId === this.#conversationId) return;
    this.#rejectPending(new Error("Switched conversation"));
    this.#url = String(this.#followUrl(new URL(this.#url), conversationId));
    const previous = this.#socket;
    this.#connected = false;
    this.#cancelReconnect();
    this.#connect();
    previous?.close();
    this.#update();
  }

  /** Closes the connection and rejects events still waiting for an ack. */
  close(): void {
    this.#closed = true;
    this.#cancelReconnect();
    this.#socket?.close();
    this.#rejectPending(new Error("Closed"));
  }

  #cancelReconnect(): void {
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#outbox.values()) pending.reject(error);
    this.#outbox.clear();
    for (const pending of this.#lists.values()) pending.reject(error);
    this.#lists.clear();
  }

  #connect(): void {
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      // A socket left behind by `follow`.
      if (socket !== this.#socket) return;
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as { type?: unknown };
      // Skip the agent's own frames on the shared connection.
      if (
        typeof frame.type === "string" &&
        frame.type.startsWith("channels:")
      ) {
        this.#receive(frame as ServerFrame);
      }
    });
    socket.addEventListener("close", () => {
      if (socket !== this.#socket) return;
      this.#connected = false;
      for (const pending of this.#lists.values()) {
        pending.reject(new Error("Disconnected"));
      }
      this.#lists.clear();
      this.#update();
      // A subscriber may have closed the client, or followed another
      // conversation, while it was told about the drop.
      if (this.#closed || socket !== this.#socket) return;
      this.#reconnect = setTimeout(() => {
        this.#reconnect = undefined;
        this.#connect();
      }, 1000);
    });
  }

  #send(frame: ClientFrame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(frame));
    }
  }

  #receive(frame: ServerFrame): void {
    // Frames for a conversation this client no longer follows.
    if (
      frame.type !== "channels:snapshot" &&
      frame.type !== "channels:ack" &&
      frame.type !== "channels:conversations" &&
      frame.conversationId !== this.#conversationId
    ) {
      return;
    }
    switch (frame.type) {
      case "channels:snapshot":
        if (frame.conversationId !== this.#conversationId) {
          if (this.#conversationId !== undefined) {
            // Following another conversation: start over from its snapshot,
            // and reconnect to it after a disconnect.
            this.#responses.clear();
            this.#url = String(
              this.#followUrl(new URL(this.#url), frame.conversationId)
            );
          }
          this.#conversationId = frame.conversationId;
        }
        this.#operations = frame.operations;
        this.#connected = true;
        this.#you = frame.you;
        this.#transcript = frame.messages;
        this.#turns.clear();
        this.#resume(frame.turns);
        for (const turn of frame.turns) this.#setTurn(turn);
        for (const { event } of this.#outbox.values()) {
          this.#send({ type: "channels:event", event });
        }
        break;
      case "channels:turn":
        this.#setTurn(frame.turn);
        this.#update();
        this.#emit({ type: "turn", turn: frame.turn });
        return;
      case "channels:messages":
        this.#upsert(frame.messages);
        return;
      case "channels:chunks": {
        const response = this.#responses.get(frame.responseId);
        // Skip chunks already received, and frames past a gap.
        const skip = (response?.chunks.length ?? 0) - frame.from;
        if (!response || skip < 0) return;
        const fresh = frame.chunks.slice(skip);
        if (fresh.length === 0) return;
        response.chunks.push(...fresh);
        this.#emit({
          type: "chunks",
          responseId: frame.responseId,
          turnId: response.turnId,
          chunks: fresh
        });
        if (!response.shown) return;
        break;
      }
      case "channels:ack": {
        const ack = this.#outbox.get(frame.eventId);
        this.#outbox.delete(frame.eventId);
        if (frame.error) ack?.reject(new Error(frame.error));
        else ack?.resolve();
        return;
      }
      case "channels:end": {
        const response = this.#responses.get(frame.responseId);
        if (!response) return;
        response.ended = true;
        // A missing response has nothing to show.
        if (!response.shown || frame.state === "not-found") {
          this.#responses.delete(frame.responseId);
        }
        this.#emit({
          type: "end",
          responseId: frame.responseId,
          turnId: response.turnId,
          state: frame.state
        });
        if (frame.state === "not-found") break;
        return;
      }
      case "channels:caught-up":
        return;
      case "channels:conversations": {
        const request =
          frame.requestId === undefined
            ? undefined
            : this.#lists.get(frame.requestId);
        if (request) this.#lists.delete(frame.requestId ?? "");
        if (frame.error) {
          request?.reject(new Error(frame.error));
          return;
        }
        if (frame.conversations) {
          this.#conversations = frame.conversations;
          request?.resolve(frame.conversations);
        }
        break;
      }
    }
    this.#update();
  }

  #upsert(messages: TranscriptMessage[]): void {
    for (const message of messages) {
      const index = this.#transcript.findIndex((m) => m.id === message.id);
      if (index === -1) this.#transcript.push(message);
      else this.#transcript[index] = message;
    }
    this.#update();
  }

  #emit(activity: WebChannelActivity): void {
    for (const listener of this.#activity) listener(activity);
  }

  /** After a reconnect, keep reading still-running responses where we were. */
  #resume(turns: TurnStatus[]): void {
    const running = new Set(
      turns.flatMap((turn) =>
        turn.status === "running" ? [turn.responseId] : []
      )
    );
    for (const [responseId, response] of this.#responses) {
      if (!running.has(responseId)) {
        this.#responses.delete(responseId);
        continue;
      }
      this.#send({
        type: "channels:subscribe",
        responseId,
        from: response.chunks.length
      });
    }
  }

  #setTurn(turn: TurnStatus): void {
    const responseId = turn.status === "running" ? turn.responseId : undefined;
    // A turn's earlier response is replaced by its next one, or by the
    // saved messages once it settles. It is kept until its end arrives.
    for (const [id, response] of this.#responses) {
      if (response.turnId === turn.turnId && id !== responseId) {
        response.shown = false;
        if (response.ended) this.#responses.delete(id);
      }
    }
    const open = turn.status !== "settled" || turn.outcome === "awaiting-input";
    if (open) this.#turns.set(turn.turnId, turn);
    else this.#turns.delete(turn.turnId);
    if (turn.status === "running" && !this.#responses.has(turn.responseId)) {
      this.#responses.set(turn.responseId, {
        turnId: turn.turnId,
        ...(turn.extends !== undefined && { extends: turn.extends }),
        chunks: [],
        shown: true,
        ended: false
      });
      this.#send({ type: "channels:subscribe", responseId: turn.responseId });
    }
  }

  #update(): void {
    const messages = [...this.#transcript];
    for (const [responseId, live] of this.#responses) {
      if (!live.shown) continue;
      const index = messages.findIndex((m) => m.id === live.extends);
      const base: TranscriptMessage =
        index === -1
          ? { id: responseId, role: "assistant", parts: [] }
          : messages[index];
      const message = applyChunks(base, live.chunks);
      if (index === -1) messages.push(message);
      else messages[index] = message;
    }
    this.#state = {
      connected: this.#connected,
      ...(this.#conversationId !== undefined && {
        conversationId: this.#conversationId
      }),
      operations: this.#operations,
      ...(this.#you && { you: this.#you }),
      messages,
      turns: [...this.#turns.values()],
      ...(this.#conversations && { conversations: this.#conversations })
    };
    for (const listener of this.#listeners) listener(this.#state);
  }
}

function defaultFollowUrl(url: URL, conversationId: string): URL {
  const next = new URL(url);
  const match = /^\/channels\/([^/]+)(?:\/[^/]+)?$/.exec(url.pathname);
  if (match) {
    next.pathname = `/channels/${match[1]}/${encodeURIComponent(conversationId)}`;
  }
  return next;
}
