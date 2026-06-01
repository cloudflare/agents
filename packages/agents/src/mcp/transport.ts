import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type MessageExtraInfo,
  type RequestInfo,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type RequestId
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  EventStore,
  StreamId,
  EventId
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getCurrentAgent, type Connection } from "..";
import type { McpAgent } from ".";
import { MessageType } from "../types";
import { MCP_HTTP_METHOD_HEADER, MCP_MESSAGE_HEADER } from "./utils";

export type { EventStore, StreamId, EventId };

export class McpSSETransport implements Transport {
  sessionId: string;
  // Set by the server in `server.connect(transport)`
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  private _getWebSocket: () => WebSocket | null;
  private _started = false;
  constructor() {
    const { agent } = getCurrentAgent<McpAgent>();
    if (!agent)
      throw new Error("McpAgent was not found in Transport constructor");

    this.sessionId = agent.getSessionId();
    this._getWebSocket = () => agent.getWebSocket();
  }

  async start() {
    // The transport does not manage the WebSocket connection since it's terminated
    // by the Durable Object in order to allow hibernation. There's nothing to initialize.
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  async send(message: JSONRPCMessage) {
    if (!this._started) {
      throw new Error("Transport not started");
    }
    const websocket = this._getWebSocket();
    if (!websocket) {
      throw new Error("WebSocket not connected");
    }
    try {
      websocket.send(JSON.stringify(message));
    } catch (error) {
      this.onerror?.(error as Error);
    }
  }

  async close() {
    // Similar to start, the only thing to do is to pass the event on to the server
    this.onclose?.();
  }
}

/**
 * Configuration options for StreamableHTTPServerTransport
 */
export interface StreamableHTTPServerTransportOptions {
  /**
   * Event store for resumability support.
   * If provided, resumability will be enabled, allowing clients to
   * reconnect and resume messages.
   *
   * If the store also implements {@link ClearableEventStore.clearStream}
   * the transport will call it after the final response of a POST
   * stream is written, so storage stays bounded without any background
   * sweep. {@link DurableObjectEventStore} is the canonical example.
   */
  eventStore?: EventStore | ClearableEventStore;
}

/**
 * An {@link EventStore} that supports dropping all events for a single
 * stream id. Implemented by {@link DurableObjectEventStore}.
 */
export interface ClearableEventStore extends EventStore {
  clearStream(streamId: StreamId): Promise<void>;
}

function isClearableEventStore(
  store: EventStore | ClearableEventStore
): store is ClearableEventStore {
  return typeof (store as ClearableEventStore).clearStream === "function";
}

/**
 * Adapted from: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts
 * - Validation and initialization are removed as they're handled in `McpAgent.serve()` handler.
 * - Replaces the Node-style `req`/`res` with Worker's `Request`.
 * - Writes events as WS messages that the Worker forwards to the client as SSE events.
 * - Replaces the in-memory maps that track requestID/stream by using `connection.setState()` and `agent.getConnections()`.
 *
 * Besides these points, the implementation is the same and should be updated to match the original as new features are added.
 */
/** Fixed streamId for the standalone GET listen stream. */
const STANDALONE_STREAM_ID = "_GET_stream";

/** State persisted on each WebSocket connection by the transport. */
type TransportConnState = {
  /** Stable identifier for the SSE stream this connection serves.
   *  Used as the event-store key. Survives WS reconnects via Last-Event-ID. */
  streamId?: string;
  /** True iff this connection is the standalone GET listen stream. */
  _standaloneSse?: boolean;
  /** Request ids whose responses must flow through this connection. */
  requestIds?: RequestId[];
};

export class StreamableHTTPServerTransport implements Transport {
  private _started = false;
  private _eventStore?: EventStore | ClearableEventStore;

  // This tracks which messages on each POST stream have been answered.
  // It is fine that we do not persist this since it only supports backwards
  // compatibility for clients batching requests, which the spec discourages.
  // Keying by stream avoids colliding ids on independent POST streams sharing
  // completion state with one another.
  private _streamResponseIds: Map<string, Set<RequestId>> = new Map();

  sessionId: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  /**
   * Optional message interceptor that can intercept messages before they are passed to onmessage.
   * If the interceptor returns true, the message is considered handled and won't be forwarded.
   * This is used by McpAgent to intercept elicitation responses.
   */
  messageInterceptor?: (
    message: JSONRPCMessage,
    extra?: MessageExtraInfo
  ) => Promise<boolean>;

  constructor(options: StreamableHTTPServerTransportOptions) {
    const { agent } = getCurrentAgent<McpAgent>();
    if (!agent)
      throw new Error("McpAgent was not found in Transport constructor");

    // Initialization is handled in `McpAgent.serve()` and agents are addressed by sessionId,
    // so we'll always have this available.
    this.sessionId = agent.getSessionId();
    this._eventStore = options.eventStore;
  }

  /**
   * Starts the transport. This is required by the Transport interface but is a no-op
   * for the Streamable HTTP transport as connections are managed per-request.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  /**
   * Handles GET requests for SSE stream.
   *
   * Two roles a GET can play:
   *   1. Fresh standalone listen stream — carries server-initiated
   *      requests/notifications unrelated to any in-progress POST.
   *   2. Resumption of a previously-disconnected stream via
   *      `Last-Event-ID`. The disconnected stream may have been the
   *      standalone stream OR a POST tool-call response stream; per the
   *      MCP 2025-03-26 spec the server replays missed messages "on the
   *      stream that was disconnected" and continues delivering
   *      subsequent messages on that same stream.
   *
   * To resume a POST stream we recover the original streamId from the
   * event-store and the original `requestIds` from durable storage,
   * then write them onto the new WS connection so `send()` keeps
   * routing in-flight tool responses to it.
   */
  async handleGetRequest(req: Request): Promise<void> {
    const { connection, agent } = getCurrentAgent<McpAgent>();
    if (!connection)
      throw new Error("Connection was not found in handleGetRequest");
    if (!agent) throw new Error("Agent was not found in handleGetRequest");

    const lastEventId = req.headers.get("last-event-id");

    // Resume path: the client identifies which stream it lost via
    // Last-Event-ID. Recover the original streamId from the event
    // store and register this connection under it. Matches the SDK
    // reference implementation (typescript-sdk's `replayEvents`):
    // the resumed connection is mapped to the *original* streamId,
    // no dual-role tagging.
    //
    // Forward routing then depends on what kind of stream it was:
    //   - active POST: persisted requestIds are restored so further
    //     tool responses route to this new WS via state.requestIds.
    //   - standalone listen stream: tag with _standaloneSse so
    //     server-initiated notifications continue to land here.
    //   - completed POST / unknown: this connection is a one-shot
    //     replay channel. No future messages will be routed to it.
    //
    // In every resumable case we supersede any prior connection bound
    // to the same streamId by closing it, so there is at most one live
    // connection per stream. This keeps `send()` routing deterministic
    // and keeps us within the MCP rule that each message goes out on
    // exactly one stream.
    if (this._eventStore && lastEventId) {
      const resumedStreamId =
        await this._eventStore.getStreamIdForEventId?.(lastEventId);
      if (resumedStreamId) {
        const resumeState: TransportConnState = {
          streamId: resumedStreamId
        };
        if (resumedStreamId === STANDALONE_STREAM_ID) {
          resumeState._standaloneSse = true;
        } else {
          const persistedReqs =
            await agent.getStreamRequestIds(resumedStreamId);
          if (persistedReqs && persistedReqs.length > 0) {
            resumeState.requestIds = persistedReqs;
          }
        }
        this.supersedePriorStreamConnections(
          agent,
          connection.id,
          resumedStreamId
        );
        connection.setState(resumeState);
        await this.replayEvents(lastEventId);
        return;
      }
    }

    // Fresh standalone listen stream. The MCP spec allows only one
    // standalone GET per session, so supersede any existing one.
    this.supersedePriorStreamConnections(
      agent,
      connection.id,
      STANDALONE_STREAM_ID
    );
    const standaloneState: TransportConnState = {
      streamId: STANDALONE_STREAM_ID,
      _standaloneSse: true
    };
    connection.setState(standaloneState);
  }

  /**
   * Close any connection (other than `selfId`) currently bound to
   * `streamId`, so at most one live connection serves a given stream.
   * Closing rather than mutating sibling state mirrors how the SDK's
   * single `_streamMapping` entry gives last-writer-wins for free, and
   * keeps `send()` from routing to a stale bridge.
   */
  private supersedePriorStreamConnections(
    agent: McpAgent,
    selfId: string,
    streamId: string
  ): void {
    for (const other of agent.getConnections<TransportConnState>()) {
      if (other.id === selfId) continue;
      if (other.state?.streamId !== streamId) continue;
      other.close(1000, "Superseded by resumed stream");
    }
  }

  /**
   * Replays events that would have been sent after the specified event ID
   * Only used when resumability is enabled
   */
  private async replayEvents(lastEventId: string): Promise<void> {
    if (!this._eventStore) {
      return;
    }

    const { connection } = getCurrentAgent();
    if (!connection)
      throw new Error("Connection was not available in replayEvents");

    try {
      await this._eventStore?.replayEventsAfter(lastEventId, {
        send: async (eventId: string, message: JSONRPCMessage) => {
          try {
            this.writeSSEEvent(connection, message, eventId);
          } catch (error) {
            this.onerror?.(error as Error);
          }
        }
      });
    } catch (error) {
      this.onerror?.(error as Error);
    }
  }

  /**
   * Writes an event to the SSE stream with proper formatting
   */
  private writeSSEEvent(
    connection: Connection,
    message: JSONRPCMessage,
    eventId?: string,
    close?: boolean
  ) {
    let eventData = "event: message\n";
    // Include event ID if provided - this is important for resumability
    if (eventId) {
      eventData += `id: ${eventId}\n`;
    }
    eventData += `data: ${JSON.stringify(message)}\n\n`;

    return connection.send(
      JSON.stringify({
        type: MessageType.CF_MCP_AGENT_EVENT,
        event: eventData,
        close
      })
    );
  }

  /**
   * Handles POST requests containing JSON-RPC messages
   */
  async handlePostRequest(
    req: Request & { auth?: AuthInfo },
    parsedBody: unknown
  ): Promise<void> {
    const authInfo: AuthInfo | undefined = req.auth;
    const requestInfo: RequestInfo = {
      headers: Object.fromEntries(req.headers.entries()),
      url: new URL(req.url)
    };
    // Remove headers that are not part of the original request
    delete requestInfo.headers[MCP_HTTP_METHOD_HEADER];
    delete requestInfo.headers[MCP_MESSAGE_HEADER];
    delete requestInfo.headers.upgrade;

    const rawMessage = parsedBody;
    let messages: JSONRPCMessage[];

    // handle batch and single messages
    if (Array.isArray(rawMessage)) {
      messages = rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg));
    } else {
      messages = [JSONRPCMessageSchema.parse(rawMessage)];
    }

    // check if it contains requests
    const hasRequests = messages.some(isJSONRPCRequest);

    if (!hasRequests) {
      // We process without sending anything
      for (const message of messages) {
        // check if message should be intercepted (i.e. elicitation responses)
        if (this.messageInterceptor) {
          const handled = await this.messageInterceptor(message, {
            authInfo,
            requestInfo
          });
          if (handled) {
            continue; // msg was handled by interceptor, skip onmessage
          }
        }
        this.onmessage?.(message, { authInfo, requestInfo });
      }
    } else if (hasRequests) {
      const { connection, agent } = getCurrentAgent<McpAgent>();
      if (!connection)
        throw new Error("Connection was not found in handlePostRequest");
      if (!agent) throw new Error("Agent was not found in handlePostRequest");

      // We need to track by request ID to maintain the connection
      const requestIds = messages
        .filter(isJSONRPCRequest)
        .map((message) => message.id);

      // The streamId is stable for the lifetime of this POST's stream.
      // We seed it with the WS connection id (unique per POST), and a
      // resumed GET later inherits the *same* streamId via Last-Event-ID.
      const streamId = connection.id;
      const postState: TransportConnState = { streamId, requestIds };
      connection.setState(postState);

      // Persist the mapping so a future GET-with-Last-Event-ID can
      // restore `requestIds` onto a fresh WS connection. Only relevant
      // when an event store is configured — without one the client has
      // no `id:` to resume from anyway. Cleaned up in `send()` on the
      // final response.
      if (this._eventStore) {
        await agent.setStreamRequestIds(streamId, requestIds);
      }

      // handle each message
      for (const message of messages) {
        if (this.messageInterceptor) {
          const handled = await this.messageInterceptor(message, {
            authInfo,
            requestInfo
          });
          if (handled) {
            continue; // Message was handled by interceptor, skip onmessage
          }
        }
        this.onmessage?.(message, { authInfo, requestInfo });
      }
      // The server SHOULD NOT close the SSE stream before sending all JSON-RPC responses
      // This will be handled by the send() method when responses are ready
    }
  }

  async close(): Promise<void> {
    // Close all SSE connections
    const { agent } = getCurrentAgent();
    if (!agent) throw new Error("Agent was not found in close");

    for (const conn of agent.getConnections()) {
      conn.close(1000, "Session closed");
    }
    this.onclose?.();
  }

  /**
   * Store the event, decide whether this is the final response, write
   * the SSE frame iff a live connection is attached, then run cleanup.
   * Caller resolves `streamId` and `relatedIds` (from connection state
   * or persisted reverse lookup) and passes `liveConnection` as null
   * when the originating WS has dropped.
   */
  private async sendOnStream(
    agent: McpAgent,
    streamId: string,
    relatedIds: readonly RequestId[],
    liveConnection: Connection<TransportConnState> | null,
    message: JSONRPCMessage,
    requestId: RequestId
  ): Promise<void> {
    const eventId = await this._eventStore?.storeEvent(streamId, message);

    let shouldClose = false;
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      let responseIds = this._streamResponseIds.get(streamId);
      if (!responseIds) {
        responseIds = new Set<RequestId>();
        this._streamResponseIds.set(streamId, responseIds);
      }
      responseIds.add(requestId);
      shouldClose = relatedIds.every((id) => responseIds.has(id));
      if (shouldClose) this._streamResponseIds.delete(streamId);
    }

    // Write FIRST, clean up SECOND. Clearing before the write would
    // leave a mid-flight client with a wiped stream on reconnect.
    // `writeSSEEvent` is sync (enqueues, doesn't await), so the bytes
    // are committed before any cleanup await can interleave. Wrap in
    // try/catch so a dead WS can't skip cleanup and orphan the
    // stream-reqs + stored events.
    if (liveConnection) {
      try {
        this.writeSSEEvent(liveConnection, message, eventId, shouldClose);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }

    if (shouldClose) {
      // A concurrent GET resume between these awaits would replay
      // events about to be deleted — benign.
      await agent.deleteStreamRequestIds(streamId);
      if (this._eventStore && isClearableEventStore(this._eventStore)) {
        await this._eventStore.clearStream(streamId);
      }
    }
  }

  async send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: RequestId }
  ): Promise<void> {
    // Request-scoped (response / `relatedRequestId` notification) vs
    // server-initiated on the standalone GET stream. Two helpers.
    const isResponse =
      isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
    const requestId = isResponse ? message.id : options?.relatedRequestId;

    if (requestId === undefined) {
      if (isResponse) {
        throw new Error(
          "Cannot send a response on a standalone SSE stream unless resuming a previous client request"
        );
      }
      return this.sendStandalone(message);
    }

    return this.sendForRequest(message, requestId);
  }

  /**
   * Server-initiated message on the standalone GET stream. Stored under
   * a fixed streamId so it's replayable even when no live connection is
   * currently attached.
   *
   * Sent on exactly one stream, per MCP: "the server MUST send each of
   * its JSON-RPC messages on only one of the connected streams; it MUST
   * NOT broadcast the same message across multiple streams."
   * `handleGetRequest` supersedes prior standalone connections, so
   * there is at most one to send on.
   */
  private async sendStandalone(message: JSONRPCMessage): Promise<void> {
    const { agent } = getCurrentAgent<McpAgent>();
    if (!agent) throw new Error("Agent was not found in send");

    const eventId = await this._eventStore?.storeEvent(
      STANDALONE_STREAM_ID,
      message
    );

    const standalone = Array.from(
      agent.getConnections<TransportConnState>()
    ).find((conn) => conn.state?._standaloneSse);
    // No live standalone stream: the event is stored above and replays
    // when a client reconnects with Last-Event-ID. Per spec the server
    // MAY send on the stream, so dropping the live write is fine.
    if (standalone) {
      this.writeSSEEvent(standalone, message, eventId);
    }
  }

  /**
   * Message scoped to a specific in-flight client request: a tool
   * response, error, or progress notification. Resolves which stream
   * owns the request id (live POST connection, resumed GET, or
   * persisted reverse lookup for a dropped WS) and delegates to
   * {@link sendOnStream} for the actual store / write / cleanup.
   */
  private async sendForRequest(
    message: JSONRPCMessage,
    requestId: RequestId
  ): Promise<void> {
    const { agent, connection: originatingConnection } =
      getCurrentAgent<McpAgent>();
    if (!agent) throw new Error("Agent was not found in send");

    // Pick the live connection that should receive this message. Normally
    // request ids uniquely identify a POST connection. If a client violates
    // that constraint, prefer the connection whose handler is currently
    // producing this message rather than leaking a plausible response to
    // the first matching POST stream. Only prefer an originating connection
    // while it is still live: after a POST stream disconnects, a resumed
    // GET connection inherits requestIds and must be allowed to receive
    // the eventual response.
    const matchingConnections = Array.from(
      agent.getConnections<TransportConnState>()
    ).filter((conn) => conn.state?.requestIds?.includes(requestId));
    const liveConnection =
      matchingConnections.find(
        (conn) => conn.id === originatingConnection?.id
      ) ?? (matchingConnections.length === 1 ? matchingConnections[0] : null);

    // Ambiguous routing: multiple live POST connections claim the same
    // request id, none of which is the originating connection. Terminate
    // each with a protocol error rather than guessing.
    if (!liveConnection && matchingConnections.length > 1) {
      const routingError: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32603, message: "Internal error" }
      };
      await Promise.all(
        matchingConnections.map((candidate) =>
          this.sendOnStream(
            agent,
            candidate.state?.streamId ?? candidate.id,
            candidate.state?.requestIds ?? [],
            candidate,
            routingError,
            requestId
          )
        )
      );
      return;
    }

    // Resolve streamId + relatedIds. Prefer the live connection's state;
    // when the originating WS has dropped fall back to the persisted
    // reverse lookup so the event can still be stored for replay —
    // mirrors the SDK's `_requestToStreamMapping` which outlives
    // connection loss.
    let streamId = liveConnection?.state?.streamId;
    let relatedIds = liveConnection?.state?.requestIds;
    if (!streamId) {
      const stored = await agent.getStreamForRequestId(requestId);
      if (!stored) {
        throw new Error(
          `No active stream found for request ID: ${String(requestId)}`
        );
      }
      streamId = stored.streamId;
      relatedIds = stored.requestIds;
    }

    await this.sendOnStream(
      agent,
      streamId,
      relatedIds ?? [],
      liveConnection,
      message,
      requestId
    );
  }
}
