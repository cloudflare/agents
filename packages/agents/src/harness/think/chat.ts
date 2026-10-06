/**
 * Think's chat wire protocol (`cf_agent_chat_*`) over a ThinkHarness
 * session, so `useAgentChat` from `agents/chat/react` (or
 * `@cloudflare/think/react`) talks to a ThinkHarness host unchanged.
 */
import type { JSONSchema7, UIMessage, UIMessageChunk } from "ai";
import type { Json } from "../../experimental/channels/protocol";
import { LifecycleCapability } from "../../lifecycle/capability";
import type { CapabilityRequestContext } from "../../lifecycle/capability-runner";
import type { Connection } from "../../lifecycle/types";
import {
  parseProtocolMessage,
  type ChatProtocolEvent
} from "../../chat/parse-protocol";
import {
  CHAT_MESSAGE_TYPES,
  STREAM_RESUME_NONE_REASONS
} from "../../chat/protocol";
import type { ClientToolSchema } from "../../chat/client-tools";
import type {
  WebSocketHandlers,
  WebSocketMessage
} from "../../websockets/options";
import type { ThinkSessionEvent } from "./events";
import { ROOT_SESSION, type ThinkHarness } from "./harness";
import type { ThinkSessionId } from "./types";

/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

/**
 * The connections the chat protocol talks to: the WebSockets capability
 * fits as is.
 *
 * @experimental
 */
export type ThinkChatConnections = {
  getConnections(): Iterable<Connection>;
  use(handlers: WebSocketHandlers): void;
};

/** `ThinkChat`'s options. @experimental */
export type ThinkChatOptions = {
  readonly harness: ThinkHarness;
  /** The WebSockets capability the clients connect through. */
  readonly webSockets: ThinkChatConnections;
  /** The session the chat serves. Default: the root session. */
  readonly session?: ThinkSessionId;
};

/** Per-operation framing state, in memory. */
type Framing = {
  /** Whether the operation's chunks continue a message the client has. */
  readonly continuation: boolean;
  /** The connection that asked for it, if one did. */
  readonly requester: string | undefined;
  /** The last model call's finish chunk, sent just before the terminal frame. */
  finish: UIMessageChunk | undefined;
};

function send(connection: Connection, frame: object): void {
  if (connection.readyState !== OPEN) return;
  try {
    connection.send(JSON.stringify(frame));
  } catch {
    // The socket closed between the state check and the send.
  }
}

/** The chat request body `useAgentChat` sends. */
type ChatRequestBody = {
  readonly messages?: readonly UIMessage[];
  readonly trigger?: string;
  readonly messageId?: string;
  readonly clientTools?: readonly ClientToolSchema[];
};

function parseBody(body: unknown): ChatRequestBody {
  if (typeof body !== "string" || body === "") return {};
  try {
    const parsed: unknown = JSON.parse(body);
    // SAFETY: the client sends the AI SDK's chat request body; every field
    // is optional and checked before use.
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ChatRequestBody)
      : {};
  } catch {
    return {};
  }
}

function clientToolsOf(
  value: readonly { name: string; description?: string; parameters?: unknown }[]
): ClientToolSchema[] {
  return value.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    // SAFETY: the client sends its tools' JSON Schemas.
    ...(tool.parameters !== undefined && {
      parameters: tool.parameters as JSONSchema7
    })
  }));
}

/**
 * Serves one ThinkHarness session over Think's chat WebSocket protocol and
 * its `GET …/get-messages` route. Install it on the Lifecycle after the
 * harness and the WebSockets capability:
 *
 * ```ts
 * readonly webSockets = new WebSockets();
 * readonly chat = new ThinkChat({ harness: this.harness, webSockets: this.webSockets });
 * readonly lifecycle = Lifecycle.install(this)
 *   .use(this.sessions).use(this.streams).use(this.harness)
 *   .use(this.webSockets).use(this.chat);
 * ```
 *
 * Supported: chat requests (`submit-message` and `regenerate-message`),
 * cancel, clear, client tool results, approvals, and stream resume after
 * a reconnect or an eviction. Not supported: `messageConcurrency`
 * strategies other than queueing, client transcript sync, and the
 * recovery progress frame.
 *
 * @experimental The API may change between releases.
 */
export class ThinkChat extends LifecycleCapability {
  readonly #harness: ThinkHarness;
  readonly #webSockets: ThinkChatConnections;
  readonly #session: ThinkSessionId;
  readonly #framing = new Map<string, Framing>();
  /** Connections told of a stream, left out of live frames until they ACK. */
  readonly #awaitingAck = new Set<string>();
  /** Per connection, the continuation flag its replay set for an operation. */
  readonly #replayed = new Map<
    string,
    { operationId: string; continuation: boolean }
  >();
  /** Connections that asked for an operation, by operation id. */
  readonly #requesters = new Map<string, string>();
  readonly #unobserve: () => void;

  /** @param options - The harness, its WebSockets, and the session to serve. */
  constructor(options: ThinkChatOptions) {
    super("think-chat");
    this.#harness = options.harness;
    this.#webSockets = options.webSockets;
    this.#session = options.session ?? ROOT_SESSION;
    this.#webSockets.use({
      onConnect: (connection) => this.#onConnect(connection),
      onMessage: (connection, message) => this.#onMessage(connection, message),
      onClose: (connection) => this.#forget(connection),
      onError: (connection) => this.#forget(connection)
    });
    this.#unobserve = this.#harness.observe((session, event) => {
      if (session === this.#session) this.#onEvent(event);
    });
  }

  /** Answer `GET …/get-messages` with the session's transcript. */
  async onRequest(
    context: CapabilityRequestContext
  ): Promise<Response | undefined> {
    const { request } = context;
    if (request.method !== "GET") return undefined;
    if (!new URL(request.url).pathname.endsWith("/get-messages")) {
      return undefined;
    }
    return Response.json(await this.#harness.session(this.#session).messages());
  }

  /** Stop listening to the harness. */
  dispose(): void {
    this.#unobserve();
  }

  // ── Connections ──────────────────────────────────────────────────────────

  async #onConnect(connection: Connection): Promise<void> {
    const session = this.#harness.session(this.#session);
    send(connection, {
      type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
      messages: await session.messages(),
      connect: true
    });
    const inFlight = await session.inFlight();
    if (inFlight) this.#offerResume(connection, inFlight.operationId);
  }

  #forget(connection: Connection): void {
    this.#awaitingAck.delete(connection.id);
    this.#replayed.delete(connection.id);
  }

  #offerResume(
    connection: Connection,
    operationId: string,
    probeId?: string
  ): void {
    this.#awaitingAck.add(connection.id);
    send(connection, {
      type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
      id: operationId,
      ...(probeId !== undefined && { probeId })
    });
  }

  async #onMessage(
    connection: Connection,
    raw: WebSocketMessage
  ): Promise<boolean> {
    if (typeof raw !== "string") return false;
    const event = parseProtocolMessage(raw);
    if (!event) return false;
    await this.#handle(connection, event);
    return true;
  }

  async #handle(connection: Connection, event: ChatProtocolEvent) {
    const session = this.#harness.session(this.#session);
    switch (event.type) {
      case "chat-request": {
        const body = parseBody(event.init.body);
        const clientTools = body.clientTools
          ? { clientTools: body.clientTools }
          : {};
        this.#requesters.set(event.id, connection.id);
        if (body.trigger === "regenerate-message") {
          await session.regenerate(undefined, { operationId: event.id });
          return;
        }
        const known = new Set(
          (await session.messages()).map((message) => message.id)
        );
        const fresh = (body.messages ?? []).filter(
          (message) => !known.has(message.id)
        );
        const receipt = await session.submit(fresh, {
          operationId: event.id,
          source: "client",
          ...clientTools
        });
        if (!receipt.accepted) {
          // A resend: if the operation already ended, end this request too.
          const status = await session.inspect(event.id);
          if (status?.status === "done" || status?.status === "unanswered") {
            this.#requesters.delete(event.id);
            await this.#finish(
              {
                operationId: status.operationId,
                status: status.status,
                ...("reason" in status &&
                  status.reason !== undefined && { reason: status.reason })
              },
              undefined,
              connection
            );
          }
        }
        return;
      }
      case "cancel":
        await session.abort(event.id);
        return;
      case "clear":
        await session.reset();
        for (const other of this.#webSockets.getConnections()) {
          if (other.id !== connection.id) {
            send(other, { type: CHAT_MESSAGE_TYPES.CHAT_CLEAR });
          }
        }
        return;
      case "tool-result": {
        const operationId = crypto.randomUUID();
        this.#requesters.set(operationId, connection.id);
        await session.submit(
          {
            type: "tool-result",
            toolCallId: event.toolCallId,
            result:
              event.state === "output-error"
                ? {
                    ok: false,
                    ...(event.errorText !== undefined && {
                      errorText: event.errorText
                    })
                  }
                : {
                    ok: true,
                    // SAFETY: the client sends tool outputs as JSON.
                    output: (event.output ?? null) as Json
                  }
          },
          {
            operationId,
            source: "client",
            autoContinue: event.autoContinue ?? true,
            ...(event.clientTools && {
              clientTools: clientToolsOf(event.clientTools)
            })
          }
        );
        return;
      }
      case "tool-approval": {
        const approvalId = await this.#approvalId(event.toolCallId);
        if (approvalId === undefined) return;
        const operationId = crypto.randomUUID();
        this.#requesters.set(operationId, connection.id);
        await session.submit(
          { type: "approval", approvalId, approved: event.approved },
          {
            operationId,
            source: "client",
            autoContinue: event.autoContinue ?? true
          }
        );
        return;
      }
      case "stream-resume-request": {
        const inFlight = await session.inFlight();
        if (inFlight) {
          this.#offerResume(connection, inFlight.operationId, event.probeId);
        } else if ((await session.pending()).length > 0) {
          send(connection, {
            type: CHAT_MESSAGE_TYPES.STREAM_PENDING,
            ...(event.probeId !== undefined && { probeId: event.probeId })
          });
        } else {
          send(connection, {
            type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE,
            reason: STREAM_RESUME_NONE_REASONS.IDLE,
            ...(event.probeId !== undefined && { probeId: event.probeId })
          });
        }
        return;
      }
      case "stream-resume-ack":
        await this.#replay(connection, event.id);
        return;
      case "messages":
        // The transcript is the server's; a client's copy is not applied.
        return;
    }
  }

  /** Replay a running model call's chunks to one connection, then go live. */
  async #replay(connection: Connection, operationId: string): Promise<void> {
    const inFlight = await this.#harness.session(this.#session).inFlight();
    if (!inFlight || inFlight.operationId !== operationId) {
      this.#awaitingAck.delete(connection.id);
      send(connection, {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: operationId,
        body: "",
        done: true,
        replay: true
      });
      return;
    }
    const { continuation, chunks } = inFlight;
    // Synchronous from here: the replay and the switch to live frames
    // happen with no chunk in between.
    let seq = 0;
    for (const chunk of chunks) {
      send(connection, {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: operationId,
        body: JSON.stringify(chunk),
        done: false,
        replay: true,
        seq: seq++,
        ...(continuation && { continuation: true })
      });
    }
    send(connection, {
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      id: operationId,
      body: "",
      done: false,
      replay: true,
      replayComplete: true,
      ...(continuation && { continuation: true })
    });
    this.#replayed.set(connection.id, { operationId, continuation });
    this.#awaitingAck.delete(connection.id);
  }

  async #approvalId(toolCallId: string): Promise<string | undefined> {
    const messages = await this.#harness.session(this.#session).messages();
    for (const message of [...messages].reverse()) {
      for (const part of message.parts) {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "approval" in part &&
          part.approval
        ) {
          return part.approval.id;
        }
      }
    }
    return undefined;
  }

  // ── Harness events ───────────────────────────────────────────────────────

  #onEvent(event: ThinkSessionEvent): void {
    switch (event.type) {
      case "run-start": {
        const requester = this.#requesters.get(event.operationId);
        this.#framing.set(event.operationId, {
          continuation: event.continuation,
          requester,
          finish: undefined
        });
        // Someone who answered a tool call learns of the continuation from
        // an offer, as Think does; a chat request's sender already owns it.
        if (event.continuation && requester !== undefined) {
          for (const connection of this.#webSockets.getConnections()) {
            if (connection.id === requester) {
              this.#offerResume(connection, event.operationId);
            }
          }
        }
        return;
      }
      case "chunk": {
        const framing = this.#framing.get(event.operationId);
        if (event.chunk.type === "finish") {
          if (framing) framing.finish = event.chunk;
          return;
        }
        this.#broadcastChunk(event.operationId, event.chunk, framing);
        return;
      }
      case "message": {
        // Messages written while placing an operation (the user's, or a
        // tool answer applied); a running turn's arrive as chunks.
        const running =
          event.operationId !== undefined &&
          this.#framing.has(event.operationId);
        if (running) return;
        const requester =
          event.operationId === undefined
            ? undefined
            : this.#requesters.get(event.operationId);
        void this.#broadcastTranscript(requester);
        return;
      }
      case "operation": {
        const { status } = event;
        if (status.status !== "done" && status.status !== "unanswered") {
          return;
        }
        const framing = this.#framing.get(status.operationId);
        this.#framing.delete(status.operationId);
        this.#requesters.delete(status.operationId);
        void this.#finish(status, framing);
        return;
      }
      case "reset":
        for (const connection of this.#webSockets.getConnections()) {
          send(connection, { type: CHAT_MESSAGE_TYPES.CHAT_CLEAR });
        }
        return;
      case "run-end":
        return;
    }
  }

  #broadcastChunk(
    operationId: string,
    chunk: UIMessageChunk,
    framing: Framing | undefined
  ): void {
    const body = JSON.stringify(chunk);
    for (const connection of this.#webSockets.getConnections()) {
      if (this.#awaitingAck.has(connection.id)) continue;
      const replayed = this.#replayed.get(connection.id);
      const continuation =
        replayed?.operationId === operationId
          ? replayed.continuation
          : (framing?.continuation ?? false);
      send(connection, {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: operationId,
        body,
        done: false,
        ...(continuation && { continuation: true })
      });
    }
  }

  async #broadcastTranscript(except?: string): Promise<void> {
    const messages = await this.#harness.session(this.#session).messages();
    for (const connection of this.#webSockets.getConnections()) {
      if (connection.id === except) continue;
      send(connection, { type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES, messages });
    }
  }

  /** The transcript first, then the terminal frame (#2119). */
  async #finish(
    status: {
      readonly operationId: string;
      readonly status: "done" | "unanswered";
      readonly reason?: string;
    },
    framing: Framing | undefined,
    only?: Connection
  ): Promise<void> {
    const { operationId } = status;
    if (framing?.finish) {
      this.#broadcastChunk(operationId, framing.finish, framing);
    }
    const messages = await this.#harness.session(this.#session).messages();
    const reason = status.status === "unanswered" ? status.reason : undefined;
    const outcome =
      status.status === "done"
        ? "completed"
        : reason === "aborted"
          ? "aborted"
          : reason === "withdrawn" ||
              reason === "not_waiting" ||
              reason === "not_found" ||
              reason === "empty"
            ? "skipped"
            : "error";
    const connections = only ? [only] : this.#webSockets.getConnections();
    for (const connection of connections) {
      send(connection, { type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES, messages });
      send(connection, {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: operationId,
        body: outcome === "error" ? (reason ?? "") : "",
        done: true,
        outcome,
        ...(outcome === "error" && { error: true }),
        ...(framing?.continuation && { continuation: true })
      });
      this.#awaitingAck.delete(connection.id);
      if (this.#replayed.get(connection.id)?.operationId === operationId) {
        this.#replayed.delete(connection.id);
      }
    }
  }
}
