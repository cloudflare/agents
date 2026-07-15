import { toErrorValue } from "../../kernel/errors.js";
import type { Connection, ConnectionRegistry } from "../../ports/transport.js";
import type { ConversationEvent, StoredEvent } from "../../domain/events/log.js";
import type { RpcRequest, RpcResponse } from "../../domain/runtime/rpc/callable.js";
import type { ChatMessage } from "../../domain/messages/model.js";
import type { ToolSet } from "../../domain/tools/types.js";
import type { Think } from "../../app/think.js";

/**
 * WS chat adapter (audit 25 §4): translates the `cf_agent_*` frame
 * vocabulary onto a `Think` instance's typed public methods and its
 * `ConversationEventLog`. This is the only module in the codebase allowed
 * to know either exists together — `src/app/` never imports `Connection`
 * or serializes a frame (see `src/app/no-transport.test.ts`).
 */

export interface AttachChatTransportOptions {
  /** Per-connection kill switch for *server-initiated* protocol frames (connect sync + event fan-out). Default: always on. */
  shouldSendProtocolMessages?: (connectionId: string) => boolean;
  /** Per-connection write guard for inbound `cf_agent_state` frames. Default: never readonly. */
  readonly?: (connectionId: string) => boolean;
}

export interface ChatTransport {
  onConnect(conn: Connection): Promise<void>;
  onMessage(conn: Connection, raw: string): Promise<void>;
  onClose(conn: Connection): void;
  detach(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A wire-supplied client tool declares its schema as raw JSON (it can't ship
 * a zod instance over the wire), so it always lands in the `{ jsonSchema }`
 * escape hatch of `Tool.inputSchema` (domain/tools/types.ts) rather than the
 * zod branch. No exact wire shape is specified upstream of this wave, so
 * this is a minimal, defensible reading of the audit's
 * `cf_agent_use_chat_request { ..., clientTools? }` field.
 */
function parseClientTools(raw: unknown): ToolSet | undefined {
  if (!isRecord(raw)) return undefined;
  const tools: ToolSet = {};
  for (const [name, def] of Object.entries(raw)) {
    if (!isRecord(def)) continue;
    tools[name] = {
      description: typeof def.description === "string" ? def.description : "",
      inputSchema: { jsonSchema: def.inputSchema ?? {} },
    };
  }
  return tools;
}

interface ParsedChatRequest {
  input?: string | ChatMessage[];
  extras: Record<string, unknown>;
}

/**
 * The original protocol wraps the chat payload in a fetch-like envelope:
 * `{ id, init: { method: "POST", body: JSON.stringify({ messages, ...extras }) } }`
 * (ISSUE-026). The body's `messages` are UIMessage-shaped — the shape our
 * ChatMessage was modeled on. Extras observed in the original suites:
 * `trigger` ("submit-message" | "regenerate-message"), `channel`, client tool
 * schemas. Legacy direct `messages`/`input` fields remain accepted for
 * internal callers; the envelope wins when present.
 */
function parseChatRequest(frame: Record<string, unknown>): ParsedChatRequest {
  const init = frame.init;
  if (isRecord(init) && typeof init.body === "string") {
    try {
      const body: unknown = JSON.parse(init.body);
      if (isRecord(body)) {
        const { messages, ...extras } = body;
        return {
          ...(Array.isArray(messages) ? { input: messages as ChatMessage[] } : {}),
          extras,
        };
      }
    } catch {
      // Malformed envelope body: fall through to the legacy fields.
    }
  }
  if (Array.isArray(frame.messages)) return { input: frame.messages as ChatMessage[], extras: frame };
  if (typeof frame.input === "string") return { input: frame.input, extras: frame };
  return { extras: {} };
}

/**
 * attachChatTransport (audit 25 §4). One call wires the whole chat protocol
 * for every connection registered in `registry`:
 *  - `onConnect`/`onMessage`/`onClose` are the per-connection hooks a host
 *    (real or in-memory) drives from its own WebSocket lifecycle;
 *  - a single subscription to `agent.events()` (installed here, at attach
 *    time) fans every live `ConversationEvent` out to every currently
 *    registered, deliverable connection — one subscription for all
 *    connections rather than one per connection, since `"live"` delivery is
 *    identical either way (a connection that joins later simply wasn't
 *    registered yet when earlier events fired, so it never would have
 *    received them under a per-connection subscription either).
 */
export function attachChatTransport(
  agent: Think,
  registry: ConnectionRegistry,
  options: AttachChatTransportOptions = {},
): ChatTransport {
  const closedConnections = new Set<string>();

  function send(conn: Connection, frame: unknown): void {
    conn.send(JSON.stringify(frame));
  }

  function protocolAllowed(connectionId: string): boolean {
    return options.shouldSendProtocolMessages?.(connectionId) ?? true;
  }

  function deliverable(connectionId: string): boolean {
    return !closedConnections.has(connectionId) && protocolAllowed(connectionId);
  }

  /** One ConversationEvent may fan out to zero, one, or (state:changed) an origin-excluded subset of connections. */
  function eventToFrame(
    event: ConversationEvent,
  ): { frame: unknown; excludeConnectionId?: string; resyncAfter?: boolean } | undefined {
    switch (event.type) {
      case "chunk":
        // Original wire shape (ISSUE-026): the chunk rides as a serialized
        // `body`; `done` marks the terminal frame of the request's stream.
        return {
          frame: {
            type: "cf_agent_use_chat_response",
            id: event.requestId,
            body: JSON.stringify(event.chunk),
            done: false,
          },
        };
      case "turn:settled": {
        // A turn suspended on a client tool or approval keeps its request
        // stream open — the continuation publishes further chunks and an
        // eventual terminal settle under the same requestId. A DURABLE-PAUSE
        // suspension is different (original semantics, execute-hitl suite):
        // the paused output is the turn's normal tool result and the request
        // is over from the client's perspective — terminal `done` fires now;
        // approveExecution later drives a fresh continuation stream.
        if (event.outcome === "suspended" && event.suspendedOn !== "durable-pause") return undefined;
        return {
          frame: {
            type: "cf_agent_use_chat_response",
            id: event.requestId,
            done: true,
            ...(event.outcome === "failed"
              ? { error: true, body: JSON.stringify({ type: "error", errorText: event.errorText ?? "turn failed" }) }
              : {}),
          },
          // The original broadcasts a full CHAT_MESSAGES sync after a turn
          // settles so every client converges on the persisted transcript.
          resyncAfter: true,
        };
      }
      case "message:updated":
        return {
          frame: {
            type: "cf_agent_message_updated",
            message: event.message,
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
          },
        };
      case "conversation:cleared":
        return { frame: { type: "cf_agent_chat_clear" } };
      case "state:changed":
        return {
          frame: { type: "cf_agent_state", state: event.state },
          ...(event.origin.kind === "client" ? { excludeConnectionId: event.origin.sourceId } : {}),
        };
      case "recovering:changed":
        return { frame: { type: "cf_agent_chat_recovering", active: event.active } };
      case "session:status":
        return {
          frame: {
            type: "cf_agent_session",
            phase: event.phase,
            tokenEstimate: event.tokenEstimate,
            ...(event.tokenThreshold !== undefined ? { tokenThreshold: event.tokenThreshold } : {}),
          },
        };
      case "run:event":
        return { frame: { type: "cf_agent_tool_run_event", runId: event.runId, event: event.event } };
      // turn:started has no direct frame counterpart: its client-visible
      // effect is the chunk stream starting.
      default:
        return undefined;
    }
  }

  /** Post-settle transcript sync (original protocol): every client converges on persisted history. */
  async function resyncAllConnections(): Promise<void> {
    const messages = await agent.history();
    for (const conn of registry.connections()) {
      if (!deliverable(conn.id)) continue;
      send(conn, { type: "cf_agent_chat_messages", messages });
    }
  }

  function broadcast(stored: StoredEvent): void {
    const mapped = eventToFrame(stored.event);
    if (!mapped) return;
    for (const conn of registry.connections()) {
      if (!deliverable(conn.id)) continue;
      if (mapped.excludeConnectionId !== undefined && mapped.excludeConnectionId === conn.id) continue;
      send(conn, mapped.frame);
    }
    if (mapped.resyncAfter) {
      void resyncAllConnections().catch(() => {
        // A failed resync is recoverable: the next connect or resume re-syncs.
      });
    }
  }

  const unsubscribe = agent.events().subscribe("live", (stored) => broadcast(stored));

  async function sendChatMessagesResync(conn: Connection): Promise<void> {
    const messages = await agent.history();
    send(conn, { type: "cf_agent_chat_messages", messages });
  }

  async function onConnect(conn: Connection): Promise<void> {
    if (!protocolAllowed(conn.id)) return;

    send(conn, { type: "cf_agent_identity", ...agent.identity(), connectionId: conn.id });

    try {
      send(conn, { type: "cf_agent_state", state: agent.state });
    } catch {
      // No persisted/initial state yet: nothing to send (audit 25 §4, "if initialized").
    }

    const active = agent.activeTurn();
    if (active) {
      // Resume is the authoritative delivery path while a stream is live:
      // announce it and SUPPRESS the CHAT_MESSAGES resync (the client would
      // otherwise double-apply the in-flight turn). Replay waits for the ACK.
      send(conn, { type: "cf_agent_stream_resuming", id: active.requestId });
    } else {
      await sendChatMessagesResync(conn);
    }

    if (agent.isRecovering()) {
      send(conn, { type: "cf_agent_chat_recovering", active: true });
    }
  }

  /**
   * Resume handshake (#1645 shape): request -> STREAM_RESUMING {id} (or
   * RESUME_NONE) -> client ACK {id} -> replay. Both a live stream and a
   * retained terminal (recovery exhaustion recorded while nobody was
   * connected) resume this way — a raw on-connect frame is dropped by real
   * clients before it reaches their stream reader.
   */
  function handleResumeRequest(conn: Connection): void {
    const active = agent.activeTurn();
    if (active) {
      send(conn, { type: "cf_agent_stream_resuming", id: active.requestId });
      return;
    }
    const terminal = agent.pendingChatTerminal();
    if (terminal) {
      send(conn, { type: "cf_agent_stream_resuming", id: terminal.requestId });
      return;
    }
    send(conn, { type: "cf_agent_stream_resume_none" });
  }

  async function handleResumeAck(conn: Connection, requestId: string): Promise<void> {
    const terminal = agent.pendingChatTerminal();
    if (terminal && terminal.requestId === requestId) {
      send(conn, {
        type: "cf_agent_use_chat_response",
        id: requestId,
        body: terminal.body,
        error: true,
        done: true,
        replay: true,
      });
      return;
    }

    // Live stream — or one that settled between RESUMING and the ACK: replay
    // the request's chunks from the log, and close with a replayed terminal
    // frame if it already settled.
    const active = agent.activeTurn();
    const from = active?.requestId === requestId ? active.startOffset : 0;
    let catchUp = agent.events().read(from);
    if (catchUp.kind === "gap") catchUp = agent.events().read(catchUp.firstAvailable);
    if (catchUp.kind === "gap") {
      // Nothing retained at all: fall back to a full resync.
      await sendChatMessagesResync(conn);
      return;
    }
    let settled: { outcome: string; errorText?: string } | undefined;
    for (const stored of catchUp.events) {
      const event = stored.event;
      if (event.type === "chunk" && event.requestId === requestId) {
        // Replay starts at the first delta: the original's resumable buffer
        // never re-sends the stream-open (`start`) — the ACKing client
        // already owns the message shell from its pre-disconnect state.
        if ((event.chunk as { type?: string }).type === "start") continue;
        send(conn, {
          type: "cf_agent_use_chat_response",
          id: requestId,
          body: JSON.stringify(event.chunk),
          done: false,
          replay: true,
        });
      } else if (event.type === "turn:settled" && event.requestId === requestId) {
        settled = { outcome: event.outcome, ...(event.errorText !== undefined ? { errorText: event.errorText } : {}) };
      }
    }
    if (settled && settled.outcome !== "suspended") {
      send(conn, {
        type: "cf_agent_use_chat_response",
        id: requestId,
        done: true,
        replay: true,
        ...(settled.outcome === "failed"
          ? { error: true, body: settled.errorText ?? "turn failed" }
          : {}),
      });
    }
  }

  async function onMessage(conn: Connection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // malformed JSON: tolerated, ignored (audit 25 §4).
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return;
    const frame = parsed;

    switch (frame.type) {
      case "cf_agent_use_chat_request": {
        const { input, extras } = parseChatRequest(frame);
        if (input === undefined) return;
        const requestId = typeof frame.id === "string" ? frame.id : agent.ids.newId("req");
        const channel = typeof extras.channel === "string" ? extras.channel : undefined;
        const clientTools = parseClientTools(extras.clientTools ?? extras.tools);
        // Fire-and-forget: chat() never rejects (it turns failures into a
        // TurnResult/callback), and the turn's own events already reach
        // every connection through the live subscription above — awaiting
        // it here would stall onMessage (and this connection's ability to
        // send e.g. a cancel frame) until the whole turn settles.
        void agent.chat(input, undefined, {
          requestId,
          ...(channel !== undefined ? { channel } : {}),
          ...(clientTools !== undefined ? { clientTools } : {}),
        });
        return;
      }
      case "cf_agent_chat_clear":
        await agent.clearMessages();
        return;
      case "cf_agent_chat_request_cancel":
        if (typeof frame.id === "string") agent.cancelChat(frame.id);
        return;
      case "cf_agent_tool_result": {
        if (typeof frame.toolCallId !== "string") return;
        await agent.applyToolResult({
          toolCallId: frame.toolCallId,
          output: frame.output,
          ...(typeof frame.isError === "boolean" ? { isError: frame.isError } : {}),
        });
        return;
      }
      case "cf_agent_tool_approval": {
        if (typeof frame.approved !== "boolean") return;
        await agent.resolveApproval({
          ...(typeof frame.toolCallId === "string" ? { toolCallId: frame.toolCallId } : {}),
          ...(typeof frame.executionId === "string" ? { executionId: frame.executionId } : {}),
          approved: frame.approved,
          ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
        });
        return;
      }
      case "cf_agent_state": {
        if (options.readonly?.(conn.id)) {
          send(conn, { type: "cf_agent_state_error", error: "connection is readonly" });
          return;
        }
        try {
          agent.setState(frame.state, { kind: "client", sourceId: conn.id });
        } catch (err) {
          send(conn, { type: "cf_agent_state_error", error: toErrorValue(err).message });
        }
        return;
      }
      case "cf_agent_stream_resume_request":
        handleResumeRequest(conn);
        return;
      case "cf_agent_stream_resume_ack":
        if (typeof frame.id === "string") await handleResumeAck(conn, frame.id);
        return;
      case "rpc": {
        if (typeof frame.id !== "string" || typeof frame.method !== "string") return;
        const request: RpcRequest = {
          id: frame.id,
          method: frame.method,
          args: Array.isArray(frame.args) ? frame.args : [],
        };
        await agent.callables().dispatch(request, (response: RpcResponse) => send(conn, response));
        return;
      }
      default:
        return; // unknown/unsupported frame types tolerated (audit 25 §4).
    }
  }

  function onClose(conn: Connection): void {
    closedConnections.add(conn.id);
  }

  function detach(): void {
    unsubscribe();
  }

  return { onConnect, onMessage, onClose, detach };
}
