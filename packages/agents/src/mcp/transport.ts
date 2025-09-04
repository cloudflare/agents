import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId
} from "@modelcontextprotocol/sdk/types.js";
import {
  isJSONRPCError,
  isJSONRPCResponse
} from "@modelcontextprotocol/sdk/types.js";

export class McpSSETransport implements Transport {
  sessionId?: string;
  // Set by the server in `server.connect(transport)`
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private _getWebSocket: () => WebSocket | null;
  private _started = false;
  constructor(getWebSocket: () => WebSocket | null) {
    this._getWebSocket = getWebSocket;
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

export class McpStreamableHttpTransport implements Transport {
  sessionId?: string;
  // Set by the server in `server.connect(transport)`
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  // The server MAY use a standalone SSE stream to send requests/notifications.
  private _getWebSocketForStandaloneSse: () => WebSocket | null;

  // Get the appropriate websocket connection for a given message id
  private _getWebSocketForMessageID: (id: string) => WebSocket | null;

  // Notify the server that a response has been sent for a given message id
  // so that it may clean up it's mapping of message ids to connections
  // once they are no longer needed
  private _notifyResponseIdSent: (id: string) => void;

  private _started = false;
  constructor(
    getWebSocketForMessageID: (id: string) => WebSocket | null,
    notifyResponseIdSent: (id: string) => void,
    getWebSocketForStandaloneSse: () => WebSocket | null
  ) {
    this._getWebSocketForMessageID = getWebSocketForMessageID;
    this._notifyResponseIdSent = notifyResponseIdSent;
    this._getWebSocketForStandaloneSse = getWebSocketForStandaloneSse;
  }

  async start() {
    // The transport does not manage the WebSocket connection since it's terminated
    // by the Durable Object in order to allow hibernation. There's nothing to initialize.
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  async send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: RequestId }
  ) {
    if (!this._started) {
      throw new Error("Transport not started");
    }
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
      const standaloneSseSocket = this._getWebSocketForStandaloneSse();
      if (!standaloneSseSocket) {
        // The spec says the server MAY send messages on the stream, so it's ok to discard if no stream
        return;
      }
      try {
        standaloneSseSocket?.send(JSON.stringify(message));
      } catch (error) {
        this.onerror?.(error as Error);
      }
      return;
    }

    const websocket = this._getWebSocketForMessageID(requestId.toString());
    if (!websocket) {
      throw new Error(`Could not find WebSocket for message id: ${requestId}`);
    }

    try {
      websocket?.send(JSON.stringify(message));
      // Cleanup on response/error
      if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
        this._notifyResponseIdSent(message.id.toString());
      }
    } catch (error) {
      this.onerror?.(error as Error);
    }
  }

  async close() {
    // Similar to start, the only thing to do is to pass the event on to the server
    this.onclose?.();
  }
}
