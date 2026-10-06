import type {
  Connection,
  ConnectionContext,
  WSMessage
} from "../../../lifecycle";
import {
  getConnectionFlag,
  registerInternalConnectionKeys,
  setConnectionFlag
} from "../../../websockets/connection-flags";
import { WebSockets } from "../../../websockets";
import type {
  ChannelsHost,
  ConversationChannel,
  ConversationUpdate
} from "../conversations";
import type {
  ConversationOperation,
  EventOrigin,
  Participant
} from "../protocol";
import {
  parseClientFrame,
  WEB_IDENTITY_HEADER,
  type ServerFrame,
  type WebIdentity
} from "./protocol";

/** Where a Channels connection's identity lives in its connection state. */
const IDENTITY_KEY = "_cf_channels";
registerInternalConnectionKeys(IDENTITY_KEY);

export type WebChannelOptions = {
  /**
   * The connections to serve conversations on, for an agent sharing its own.
   * Default: the WebSockets Channels shares, created on first use.
   */
  websockets?: WebSockets;
};

type Identity = Omit<WebIdentity, "conversationId"> & {
  conversationId: string;
  channelKey: string;
};

/**
 * Serves conversations over the agent's WebSockets connections, to clients
 * the gateway has resolved. Frames are
 * namespaced `channels:`, so a connection can carry other protocols too.
 */
export class WebChannel implements ConversationChannel {
  readonly #options: WebChannelOptions;
  #websockets: WebSockets | undefined;
  #host: ChannelsHost | undefined;
  /** Frames held back until a connection has its snapshot. */
  readonly #pending = new Map<string, ServerFrame[]>();
  /** Active response reads, by connection, then response. */
  readonly #reads = new Map<string, Map<string, AbortController>>();

  constructor(options: WebChannelOptions = {}) {
    this.#options = options;
  }

  mount(host: ChannelsHost): void {
    if (this.#host) throw new Error("A WebChannel can be mounted only once");
    this.#host = host;
    this.#websockets =
      this.#options.websockets ?? host.websockets(() => new WebSockets());
    this.#websockets.use({
      onConnect: (connection, ctx) => this.#connect(connection, ctx),
      onMessage: (connection, message) => this.#message(connection, message),
      onClose: (connection) => this.#close(connection)
    });
  }

  publish(conversationId: string, update: ConversationUpdate): void {
    for (const [connection, identity] of this.#connections()) {
      if (identity.conversationId !== conversationId) continue;
      // The sender adds its own message once the agent accepts it.
      if (update.type === "messages" && this.#sentBy(update, connection)) {
        continue;
      }
      if (update.type === "reset") this.#stopReads(connection.id);
      const frame = toFrame(
        update,
        conversationId,
        identity.participant,
        this.#mounted().operations
      );
      const pending = this.#pending.get(connection.id);
      if (pending) pending.push(frame);
      else send(connection, frame);
    }
  }

  async #connect(
    connection: Connection,
    { request }: ConnectionContext
  ): Promise<void> {
    const header = request.headers.get(WEB_IDENTITY_HEADER);
    if (header === null) return;
    // The gateway is the trust boundary: it resolves who is connecting and
    // sets this header. The agent must only be reachable through the
    // gateway, or a caller could forge the header and join as anyone.
    // There is no further authorization here: the agent object is the
    // boundary, so a connection may use every conversation in it.
    // SAFETY: only the gateway sets this header, with a WebIdentity.
    const resolved = JSON.parse(header) as WebIdentity;
    const host = this.#mounted();
    const identity: Identity = {
      ...resolved,
      conversationId: resolved.conversationId ?? host.defaultConversation(),
      channelKey: host.channelKey
    };
    setConnectionFlag(connection, IDENTITY_KEY, identity);
    // Listen for pushes before reading the snapshot, so none are lost.
    this.#pending.set(connection.id, []);
    await this.#sendSnapshot(connection, identity);
  }

  async #message(connection: Connection, message: WSMessage): Promise<boolean> {
    const identity = this.#identityOf(connection);
    if (!identity || typeof message !== "string") return false;
    const frame = parseClientFrame(message);
    if (!frame) return false;

    if ("invalid" in frame) {
      send(connection, {
        type: "channels:ack",
        conversationId: identity.conversationId,
        eventId: frame.eventId ?? "",
        error: `Invalid frame: ${frame.invalid}`
      });
      return true;
    }
    if (frame.type === "channels:list-conversations") {
      await this.#list(connection, identity, frame.requestId);
      return true;
    }
    if (frame.type === "channels:subscribe") {
      this.#subscribe(connection, identity, frame.responseId, frame.from);
      return true;
    }

    const { eventId } = frame.event;
    let result;
    try {
      result = await this.#mounted().dispatch(
        frame.event,
        origin(identity, connection.id)
      );
    } catch {
      send(connection, {
        type: "channels:ack",
        conversationId: identity.conversationId,
        eventId,
        error: "Event rejected"
      });
      return true;
    }
    // The sender follows a conversation it created or forked; other
    // connections stay where they are. Acknowledge first: a client resends
    // unacknowledged events on every snapshot, and the new conversation's
    // snapshot would otherwise carry the create or fork into it again.
    const followed = result.conversationId;
    send(connection, {
      type: "channels:ack",
      conversationId: followed ?? identity.conversationId,
      eventId
    });
    if (followed !== undefined && followed !== identity.conversationId) {
      await this.#follow(connection, { ...identity, conversationId: followed });
    }
    if (followed !== undefined) await this.#pushConversations();
    return true;
  }

  async #list(
    connection: Connection,
    identity: Identity,
    requestId: string
  ): Promise<void> {
    // The agent object is the authorization boundary, so every connection
    // may list every conversation in it.
    const frame = {
      type: "channels:conversations" as const,
      conversationId: identity.conversationId,
      requestId
    };
    try {
      const conversations = await this.#mounted().listConversations();
      send(connection, { ...frame, conversations });
    } catch (error) {
      console.error("Failed to list conversations", error);
      send(connection, { ...frame, error: "Failed to list conversations" });
    }
  }

  /** Tell every connection the agent's conversations changed. */
  async #pushConversations(): Promise<void> {
    let conversations;
    try {
      conversations = await this.#mounted().listConversations();
    } catch (error) {
      console.error("Failed to list conversations", error);
      return;
    }
    for (const [connection, identity] of this.#connections()) {
      const frame: ServerFrame = {
        type: "channels:conversations",
        conversationId: identity.conversationId,
        conversations
      };
      const pending = this.#pending.get(connection.id);
      if (pending) pending.push(frame);
      else send(connection, frame);
    }
  }

  /** Move a connection to another conversation, starting from its snapshot. */
  async #follow(connection: Connection, identity: Identity): Promise<void> {
    this.#stopReads(connection.id);
    setConnectionFlag(connection, IDENTITY_KEY, identity);
    this.#pending.set(connection.id, []);
    await this.#sendSnapshot(connection, identity);
  }

  #close(connection: Connection): void {
    this.#stopReads(connection.id);
    this.#pending.delete(connection.id);
  }

  #sentBy(
    update: Extract<ConversationUpdate, { type: "messages" }>,
    connection: Connection
  ): boolean {
    const surface = update.origin?.surface;
    return (
      surface !== undefined &&
      surface.channelKey === this.#host?.channelKey &&
      connectionIdOf(surface.address) === connection.id
    );
  }

  async #sendSnapshot(
    connection: Connection,
    identity: Identity
  ): Promise<void> {
    try {
      const snapshot = await this.#mounted().snapshot(identity.conversationId);
      send(connection, {
        type: "channels:snapshot",
        conversationId: identity.conversationId,
        you: identity.participant,
        operations: [...this.#mounted().operations],
        ...snapshot
      });
      for (const frame of this.#pending.get(connection.id) ?? []) {
        send(connection, frame);
      }
      this.#pending.delete(connection.id);
    } catch (error) {
      console.error("Failed to read the conversation snapshot", error);
      this.#pending.delete(connection.id);
      connection.close(1011, "Snapshot failed");
    }
  }

  /** One read per response per connection; a repeated subscribe joins it. */
  #subscribe(
    connection: Connection,
    identity: Identity,
    responseId: string,
    from: number | undefined
  ): void {
    let reads = this.#reads.get(connection.id);
    if (!reads) this.#reads.set(connection.id, (reads = new Map()));
    if (reads.has(responseId)) return;
    const controller = new AbortController();
    reads.set(responseId, controller);

    const { conversationId } = identity;
    this.#mounted()
      .readResponse(conversationId, responseId, {
        from,
        signal: controller.signal,
        onChunks: (first, chunks) =>
          send(connection, {
            type: "channels:chunks",
            conversationId,
            responseId,
            from: first,
            chunks
          }),
        onCaughtUp: (cursor) =>
          send(connection, {
            type: "channels:caught-up",
            conversationId,
            responseId,
            cursor
          })
      })
      .then(
        (ending) =>
          send(connection, {
            type: "channels:end",
            conversationId,
            responseId,
            state: ending
          }),
        (error) => {
          if (controller.signal.aborted) return;
          console.error(`Failed to read response "${responseId}"`, error);
          // Tell the client the read is over, so it does not wait forever.
          send(connection, {
            type: "channels:end",
            conversationId,
            responseId,
            state: "interrupted"
          });
        }
      )
      .finally(() => reads.delete(responseId));
  }

  #stopReads(connectionId: string): void {
    for (const controller of this.#reads.get(connectionId)?.values() ?? []) {
      controller.abort();
    }
    this.#reads.delete(connectionId);
  }

  *#connections(): Iterable<[Connection, Identity]> {
    for (const connection of this.#websockets?.getConnections() ?? []) {
      const identity = this.#identityOf(connection);
      if (identity) yield [connection, identity];
    }
  }

  #identityOf(connection: Connection): Identity | undefined {
    // SAFETY: only #connect writes this key, with an Identity.
    const identity = getConnectionFlag(connection, IDENTITY_KEY) as
      | Identity
      | undefined;
    return identity?.channelKey === this.#host?.channelKey
      ? identity
      : undefined;
  }

  #mounted(): ChannelsHost {
    if (!this.#host) throw new Error("WebChannel is not mounted");
    return this.#host;
  }
}

function origin(identity: Identity, connectionId: string): EventOrigin {
  return {
    conversationId: identity.conversationId,
    participant: identity.participant,
    surface: {
      channelKey: identity.channelKey,
      version: 1,
      address: { conversationId: identity.conversationId, connectionId },
      label: "Web"
    }
  };
}

function connectionIdOf(address: unknown): string | undefined {
  return typeof address === "object" &&
    address !== null &&
    "connectionId" in address &&
    typeof address.connectionId === "string"
    ? address.connectionId
    : undefined;
}

function toFrame(
  update: ConversationUpdate,
  conversationId: string,
  you: Participant,
  operations: readonly ConversationOperation[]
): ServerFrame {
  switch (update.type) {
    case "turn":
      return { type: "channels:turn", conversationId, turn: update.turn };
    case "messages":
      return {
        type: "channels:messages",
        conversationId,
        messages: update.messages
      };
    case "reset":
      return {
        type: "channels:snapshot",
        conversationId,
        you,
        operations: [...operations],
        messages: [],
        turns: []
      };
    case "response-end":
      return {
        type: "channels:end",
        conversationId,
        responseId: update.responseId,
        state: update.ending
      };
  }
}

/** A failed send to one stale socket must not stop delivery to the rest. */
function send(connection: Connection, frame: ServerFrame): void {
  try {
    connection.send(JSON.stringify(frame));
  } catch {
    // The socket is closing; its close handler cleans up.
  }
}
