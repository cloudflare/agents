import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type MessageExtraInfo,
  type RequestInfo,
  isJSONRPCError,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type RequestId
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getCurrentAgent, type Connection } from "..";
import type { McpAgent } from ".";
import { MessageType } from "../ai-types";
import { MCP_HTTP_METHOD_HEADER, MCP_MESSAGE_HEADER } from "./utils";

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

export type StreamId = string;
export type EventId = string;

// TODO: Implement this and make it opt-in?
/**
 * Interface for resumability support via event storage
 */
export interface EventStore {
  /**
   * Stores an event for later retrieval
   * @param streamId ID of the stream the event belongs to
   * @param message The JSON-RPC message to store
   * @returns The generated event ID for the stored event
   */
  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;

  replayEventsAfter(
    lastEventId: EventId,
    {
      send
    }: {
      send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
    }
  ): Promise<StreamId>;
}

/**
 * Configuration options for StreamableHTTPServerTransport
 */
export interface StreamableHTTPServerTransportOptions {
  /**
   * Event store for resumability support
   * If provided, resumability will be enabled, allowing clients to reconnect and resume messages
   */
  eventStore?: EventStore;
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
export class StreamableHTTPServerTransport implements Transport {
  private _started = false;
  private _eventStore?: EventStore;

  // This is to keep track whether all messages from a single POST request have been answered.
  // I's fine that we don't persist this since it's only for backwards compatibility as clients
  // should no longer batch requests, per the spec.
  private _requestResponseMap: Map<RequestId, JSONRPCMessage> = new Map();

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
   * Handles GET requests for SSE stream
   */
  async handleGetRequest(req: Request): Promise<void> {
    // Get the WS connection so we can tag it as the standalone stream
    const { connection } = getCurrentAgent();
    if (!connection)
      throw new Error("Connection was not found in handleGetRequest");

    // Handle resumability: check for Last-Event-ID header
    if (this._eventStore) {
      const lastEventId = req.headers.get("last-event-id");
      if (lastEventId) {
        await this.replayEvents(lastEventId);
        return;
      }
    }

    connection.setState({
      _standaloneSse: true
    });
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
      headers: Object.fromEntries(req.headers.entries())
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
      const { connection } = getCurrentAgent();
      if (!connection)
        throw new Error("Connection was not found in handlePostRequest");

      // We need to track by request ID to maintain the connection
      const requestIds = messages
        .filter(isJSONRPCRequest)
        .map((message) => message.id);

      connection.setState({
        requestIds
      });

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

  async send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: RequestId }
  ): Promise<void> {
    const { agent } = getCurrentAgent();
    if (!agent) throw new Error("Agent was not found in send");

    let requestId = options?.relatedRequestId;
    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      // If the message is a response, use the request ID from the message
      requestId = message.id;
    }

    // Check if this message should be sent on the standalone SSE stream (no request ID)
    // Ignore notifications from tools (which have relatedRequestId set)
    // Those will be sent via dedicated response SSE streams
    if (requestId === undefined) {
      // For standalone SSE streams, we can only send requests and notifications
      if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
        throw new Error(
          "Cannot send a response on a standalone SSE stream unless resuming a previous client request"
        );
      }

      let standaloneConnection: Connection | undefined;
      for (const conn of agent.getConnections<{ _standaloneSse?: boolean }>()) {
        if (conn.state?._standaloneSse) standaloneConnection = conn;
      }

      if (standaloneConnection === undefined) {
        // The spec says the server MAY send messages on the stream, so it's ok to discard if no stream
        return;
      }

      // Generate and store event ID if event store is provided
      let eventId: string | undefined;
      if (this._eventStore) {
        // Stores the event and gets the generated event ID
        eventId = await this._eventStore.storeEvent(
          standaloneConnection.id,
          message
        );
      }

      // Send the message to the standalone SSE stream
      this.writeSSEEvent(standaloneConnection, message, eventId);
      return;
    }

    // Get the response for this request
    const connection = Array.from(
      agent.getConnections<{ requestIds?: number[] }>()
    ).find((conn) => conn.state?.requestIds?.includes(requestId as number));
    if (!connection) {
      throw new Error(
        `No connection established for request ID: ${String(requestId)}`
      );
    }

    let eventId: string | undefined;

    if (this._eventStore) {
      eventId = await this._eventStore.storeEvent(connection.id, message);
    }

    let shouldClose = false;

    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      this._requestResponseMap.set(requestId, message);
      const relatedIds = connection.state?.requestIds ?? [];
      // Check if we have responses for all requests using this connection
      shouldClose = relatedIds.every((id) => this._requestResponseMap.has(id));

      if (shouldClose) {
        // Clean up
        for (const id of relatedIds) {
          this._requestResponseMap.delete(id);
        }
      }
    }
    this.writeSSEEvent(connection, message, eventId, shouldClose);
  }
}
