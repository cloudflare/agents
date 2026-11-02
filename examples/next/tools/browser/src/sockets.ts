import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  ConversationWatch,
  ConversationWindow,
  RegistryReader
} from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import {
  ROOT_CONVERSATION,
  type PiHarness,
  type PiConversationId
} from "agents/harness/pi";
import type { PiClientMessage, PiServerMessage } from "./protocol";

const CONVERSATION_TAG_PREFIX = "pi-conversation:";
const CONVERSATION_QUERY = "conversation";
/**
 * How many entries a socket's view holds: the newest 200, up to 400. A
 * longer transcript shows only its newest entries; a client that pages older
 * ones merges the view into a `ConversationTranscript` instead.
 */
const WINDOW: ConversationWindow = { min: 200 };
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

function conversationTag(conversation: PiConversationId): string {
  return `${CONVERSATION_TAG_PREFIX}${conversation}`;
}

function conversationFromRequest(
  request: Request,
  fallback: PiConversationId
): string {
  const conversation = new URL(request.url).searchParams.get(
    CONVERSATION_QUERY
  );
  if (conversation === null || conversation === "") return fallback;
  if (!/^[1-9][0-9]{0,15}$/.test(conversation)) {
    throw new Error(`Invalid pi conversation ${JSON.stringify(conversation)}`);
  }
  return conversation;
}

function conversationOf(tags: readonly string[]): string | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(CONVERSATION_TAG_PREFIX)
  );
  return tag?.slice(CONVERSATION_TAG_PREFIX.length);
}

function send(socket: WebSocket, message: PiServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

/**
 * App glue: this app's conversation protocol over the `WebSockets` capability,
 * built only on the harness's public API.
 *
 * Each socket follows one conversation, picked by `?conversation=`, through its own
 * `conversation.watch()`: the whole view, then pi's operations for each change.
 * Commands on the socket call `conversation.submit()`, `abort()`, and `reset()`.
 * Watches live in memory, so the host calls `reattach()` from its `onStart`
 * to give sockets that outlived the last isolate a new watch and the whole
 * view again.
 */
export class PiConversationSockets {
  readonly #harness: PiHarness;
  readonly #registry: RegistryReader;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #watches = new Map<WebSocket, ConversationWatch>();

  constructor(
    harness: PiHarness,
    /** The registry pi was opened with, for the tool list sent on connect. */
    registry: RegistryReader,
    getWebSockets: (tag?: string) => WebSocket[]
  ) {
    this.#harness = harness;
    this.#registry = registry;
    this.#getWebSockets = getWebSockets;
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => [
        conversationTag(conversationFromRequest(ctx.request, ROOT_CONVERSATION))
      ],
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#unwatch(connection),
        onError: (connection) => this.#unwatch(connection)
      }
    };
  }

  /** Give every hibernated socket a new watch after the object restarts. */
  async reattach(): Promise<void> {
    if (this.#getWebSockets().length === 0) return;
    // Sockets are found by tag, not tags by socket, so walk the conversations
    // and look up each one's tag.
    for (const { id } of await this.#harness.conversations.list()) {
      for (const socket of this.#getWebSockets(conversationTag(id))) {
        await this.#watch(socket, id);
      }
    }
  }

  async close(): Promise<void> {
    const watches = [...this.#watches.values()];
    this.#watches.clear();
    await Promise.all(watches.map((watch) => watch.stop()));
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext) {
    const conversation = conversationFromRequest(
      ctx.request,
      ROOT_CONVERSATION
    );
    send(connection, {
      type: "hello",
      conversation,
      tools: this.#registry
        .snapshot()
        .tools()
        .map(({ tool }) => ({ name: tool.name, description: tool.description }))
    });
    await this.#watch(connection, conversation);
  }

  async #watch(
    socket: WebSocket,
    conversation: PiConversationId
  ): Promise<void> {
    await this.#unwatch(socket);
    const watch = await this.#harness.conversation(conversation).watch(WINDOW);
    this.#watches.set(socket, watch);
    send(socket, { type: "view", conversation, view: watch.value });
    watch.start(async (call) => {
      // Pi ends a watch on failure instead of sending a `failed` call.
      if (call.kind !== "value") return;
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);
        return;
      }
      send(socket, { type: "ops", conversation, ops: call.ops });
    });
  }

  async #unwatch(socket: WebSocket): Promise<void> {
    const watch = this.#watches.get(socket);
    if (!watch) return;
    this.#watches.delete(socket);
    await watch.stop();
  }

  async #onMessage(connection: Connection, raw: WebSocketMessage) {
    if (typeof raw !== "string") return;
    let message: PiClientMessage;
    try {
      message = JSON.parse(raw) as PiClientMessage;
    } catch {
      send(connection, { type: "error", message: "Malformed JSON" });
      return;
    }
    const conversation = conversationOf(connection.tags) ?? ROOT_CONVERSATION;
    try {
      const result = await this.#dispatch(connection, conversation, message);
      if (message.id !== undefined) {
        send(connection, { type: "result", id: message.id, result });
      }
    } catch (error) {
      send(connection, {
        type: "error",
        ...(message.id === undefined ? {} : { id: message.id }),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #dispatch(
    connection: Connection,
    conversation: PiConversationId,
    message: PiClientMessage
  ): Promise<JsonValue> {
    const handle = this.#harness.conversation(conversation);
    switch (message.type) {
      case "submit":
        return await handle.submit(message.input, {
          ...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
          ...(message.operationId ? { operationId: message.operationId } : {})
        });
      case "abort":
        return await handle.abort();
      case "reset":
        await handle.reset(message.handoff);
        return null;
      case "resync":
        await this.#watch(connection, conversation);
        return null;
      default:
        throw new Error(
          `Unknown pi message type ${JSON.stringify((message as { type: string }).type)}`
        );
    }
  }
}
