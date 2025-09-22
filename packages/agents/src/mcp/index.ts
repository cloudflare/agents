import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  JSONRPCMessageSchema,
  isJSONRPCError,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import type { Connection, ConnectionContext, WSMessage } from "../";
import { Agent } from "../index";
import type { MaybePromise, ServeOptions, TransportType } from "./types";

interface SamplingResult {
  model: string;
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | string;
  role: "user" | "assistant";
  content:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };
}

// Hibernation-safe storage types for pending requests
interface BaseStoredRequest {
  requestId: string;
  timestamp: number;
}

interface StoredElicitationRequest extends BaseStoredRequest {
  type: "elicitation";
  message: string;
  requestedSchema: unknown;
}

interface StoredSamplingRequest extends BaseStoredRequest {
  type: "sampling";
  params: {
    messages: Array<{
      role: "user" | "assistant";
      content:
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string };
    }>;
    modelPreferences?: {
      hints?: Array<{ name?: string }>;
      costPriority?: number;
      speedPriority?: number;
      intelligencePriority?: number;
    };
    systemPrompt?: string;
    includeContext?: "none" | "thisServer" | "allServers";
    temperature?: number;
    maxTokens: number;
    stopSequences?: string[];
    metadata?: Record<string, unknown>;
  };
}

type StoredRequest = StoredElicitationRequest | StoredSamplingRequest;

// Constants for standalone SSE handling
const STANDALONE_SSE_METHOD = "standalone-sse-setup";
const STANDALONE_SSE_MARKER = "standalone-sse";

import {
  createLegacySseHandler,
  createStreamingHttpHandler,
  handleCORS,
  isDurableObjectNamespace,
  MCP_HTTP_METHOD_HEADER,
  MCP_MESSAGE_HEADER
} from "./utils";
import { McpSSETransport, StreamableHTTPServerTransport } from "./transport";

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private static readonly REQUEST_TIMEOUT_MS = 60000; // 60 seconds
  private static readonly ELICITATION_REQUESTS_KEY = "pending_elicitations";
  private static readonly SAMPLING_REQUESTS_KEY = "pending_samplings";

  private _transport?: Transport;
  private _requestIdToConnectionId: Map<string | number, string> = new Map();
  // The connection ID for server-sent requests/notifications
  private _standaloneSseConnectionId?: string;
  private _pendingElicitations = new Map<
    string,
    {
      resolve: (result: ElicitResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private _pendingSamplings = new Map<
    string,
    {
      resolve: (result: SamplingResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  props?: Props;

  abstract server: MaybePromise<McpServer | Server>;
  abstract init(): Promise<void>;

  /*
   * Helpers
   */

  /** Clean up all pending requests / hibernation safety */
  private async _cleanupAllPendingRequests(): Promise<void> {
    // Clear in-memory maps (hibernation recovery)
    for (const [requestId] of this._pendingElicitations) {
      await this._cleanupRequest<StoredElicitationRequest, ElicitResult>(
        requestId,
        this._pendingElicitations,
        McpAgent.ELICITATION_REQUESTS_KEY,
        "elicitation"
      );
    }

    for (const [requestId] of this._pendingSamplings) {
      await this._cleanupRequest<StoredSamplingRequest, SamplingResult>(
        requestId,
        this._pendingSamplings,
        McpAgent.SAMPLING_REQUESTS_KEY,
        "sampling"
      );
    }

    // Restore any persisted requests from before hibernation
    await this._restorePendingRequests();
  }

  private async _storeRequest<T extends StoredRequest>(
    request: T,
    storageKey: string
  ): Promise<void> {
    const stored =
      (await this.ctx.storage.get<Record<string, T>>(storageKey)) || {};
    stored[request.requestId] = request;
    await this.ctx.storage.put(storageKey, stored);
  }

  private async _removeRequest<T extends StoredRequest>(
    requestId: string,
    storageKey: string
  ): Promise<void> {
    const stored =
      (await this.ctx.storage.get<Record<string, T>>(storageKey)) || {};
    delete stored[requestId];

    if (Object.keys(stored).length === 0) {
      await this.ctx.storage.delete(storageKey);
    } else {
      await this.ctx.storage.put(storageKey, stored);
    }
  }

  private async _getStoredRequests<T extends StoredRequest>(
    storageKey: string
  ): Promise<Record<string, T> | null> {
    return (await this.ctx.storage.get<Record<string, T>>(storageKey)) || null;
  }

  private async _restoreRequestsOfType<T extends StoredRequest>(
    storageKey: string,
    createPromiseMethod: (requestId: string, timeoutMs: number) => void,
    removeMethod: (requestId: string) => Promise<void>
  ): Promise<void> {
    const currentTime = Date.now();
    const timeoutMs = McpAgent.REQUEST_TIMEOUT_MS;

    const storedRequests = await this._getStoredRequests<T>(storageKey);

    if (storedRequests) {
      for (const [requestId, request] of Object.entries(storedRequests)) {
        // Check if request has expired
        if (currentTime - request.timestamp > timeoutMs) {
          await removeMethod(requestId);
          continue;
        }

        // Recreate promise for this request, it will timeout naturally
        const remainingTime = Math.max(
          0,
          timeoutMs - (currentTime - request.timestamp)
        );
        createPromiseMethod(requestId, remainingTime);
      }
    }
  }

  /** Restore pending requests after hibernation and recreate promises */
  private async _restorePendingRequests(): Promise<void> {
    // Restore elicitation requests
    await this._restoreRequestsOfType<StoredElicitationRequest>(
      McpAgent.ELICITATION_REQUESTS_KEY,
      (requestId, timeoutMs) => {
        this._createPromise<ElicitResult>(
          requestId,
          timeoutMs,
          this._pendingElicitations,
          (id) =>
            this._removeRequest<StoredElicitationRequest>(
              id,
              McpAgent.ELICITATION_REQUESTS_KEY
            ),
          "Elicitation request timed out"
        );
      },
      (requestId) =>
        this._removeRequest<StoredElicitationRequest>(
          requestId,
          McpAgent.ELICITATION_REQUESTS_KEY
        )
    );

    // Restore sampling requests
    await this._restoreRequestsOfType<StoredSamplingRequest>(
      McpAgent.SAMPLING_REQUESTS_KEY,
      (requestId, timeoutMs) => {
        this._createPromise<SamplingResult>(
          requestId,
          timeoutMs,
          this._pendingSamplings,
          (id) =>
            this._removeRequest<StoredSamplingRequest>(
              id,
              McpAgent.SAMPLING_REQUESTS_KEY
            ),
          "Sampling request timed out"
        );
      },
      (requestId) =>
        this._removeRequest<StoredSamplingRequest>(
          requestId,
          McpAgent.SAMPLING_REQUESTS_KEY
        )
    );
  }

  private _createPromise<T>(
    requestId: string,
    timeoutMs: number,
    pendingMap: Map<
      string,
      {
        resolve: (result: T) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >,
    removeStorageMethod: (requestId: string) => Promise<void>,
    timeoutMessage: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(async () => {
        pendingMap.delete(requestId);
        await removeStorageMethod(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      pendingMap.set(requestId, {
        resolve: async (result: T) => {
          await removeStorageMethod(requestId);
          resolve(result);
        },
        reject: async (error: Error) => {
          await removeStorageMethod(requestId);
          reject(error);
        },
        timeout
      });
    });
  }

  async setInitializeRequest(initializeRequest: JSONRPCMessage) {
    await this.ctx.storage.put("initializeRequest", initializeRequest);
  }

  async getInitializeRequest() {
    return this.ctx.storage.get<JSONRPCMessage>("initializeRequest");
  }

  /** Read the transport type for this agent.
   * This relies on the naming scheme being `sse:${sessionId}`
   * or `streamable-http:${sessionId}`.
   */
  getTransportType(): TransportType {
    const [t, ..._] = this.name.split(":");
    switch (t) {
      case "sse":
        return "sse";
      case "streamable-http":
        return "streamable-http";
      default:
        throw new Error(
          "Invalid transport type. McpAgent must be addressed with a valid protocol."
        );
    }
  }

  /** Read the sessionId for this agent.
   * This relies on the naming scheme being `sse:${sessionId}`
   * or `streamable-http:${sessionId}`.
   */
  getSessionId(): string {
    const [_, sessionId] = this.name.split(":");
    if (!sessionId) {
      throw new Error(
        "Invalid session id. McpAgent must be addressed with a valid session id."
      );
    }
    return sessionId;
  }

  /** Get the unique WebSocket. SSE transport only. */
  private getWebSocket() {
    const websockets = Array.from(this.getConnections());
    if (websockets.length === 0) {
      return null;
    }
    return websockets[0];
  }

  /** Returns a new transport matching the type of the Agent. */
  private initTransport() {
    switch (this.getTransportType()) {
      case "sse": {
        return new McpSSETransport(() => this.getWebSocket());
      }
      case "streamable-http": {
        return new StreamableHTTPServerTransport({});
      }
    }
  }

  /** Update and store the props */
  async updateProps(props?: Props) {
    await this.ctx.storage.put("props", props ?? {});
    this.props = props;
  }

  async reinitializeServer() {
    // If the agent was previously initialized, we have to populate
    // the server again by sending the initialize request to make
    // client information available to the server.
    const initializeRequest = await this.getInitializeRequest();
    if (initializeRequest) {
      this._transport?.onmessage?.(initializeRequest);
    }
  }

  /*
   * Base Agent / Parykit Server overrides
   */

  /** Sets up the MCP transport and server every time the Agent is started.*/
  async onStart(props?: Props) {
    // If onStart was passed props, save them in storage
    if (props) await this.updateProps(props);
    this.props = await this.ctx.storage.get("props");

    // restore any pending requests from storage
    await this._cleanupAllPendingRequests();

    await this.init();
    const server = await this.server;
    // Connect to the MCP server
    this._transport = this.initTransport();
    await server.connect(this._transport);

    // Intercept transport messages for elicitation/sampling handling
    this._wrapTransportOnMessage();

    await this.reinitializeServer();
  }

  /** Intercept transport messages to handle elicitation/sampling responses */
  private _wrapTransportOnMessage() {
    if (this._transport?.onmessage) {
      const originalOnMessage = this._transport.onmessage;
      this._transport.onmessage = async (message, extra) => {
        // Check if this is an elicitation response before passing to MCP server
        if (await this._handleElicitationResponse(message)) {
          return; // Message was handled by elicitation system
        }

        // Check if this is a sampling response before passing to MCP server
        if (await this._handleSamplingResponse(message)) {
          return; // Message was handled by sampling system
        }

        // Pass through to original MCP server handler
        originalOnMessage(message, extra);
      };
    }
  }

  /** Validates new WebSocket connections. */
  async onConnect(
    conn: Connection,
    { request: req }: ConnectionContext
  ): Promise<void> {
    switch (this.getTransportType()) {
      case "sse": {
        // For SSE connections, we can only have one open connection per session
        // If we get an upgrade while already connected, we should error
        const websockets = Array.from(this.getConnections());
        if (websockets.length > 1) {
          conn.close(1008, "Websocket already connected");
          return;
        }
        break;
      }
      case "streamable-http":
        if (this._transport instanceof StreamableHTTPServerTransport) {
          switch (req.headers.get(MCP_HTTP_METHOD_HEADER)) {
            case "POST": {
              // This returns the repsonse directly to the client
              const payloadHeader = req.headers.get(MCP_MESSAGE_HEADER);
              const parsedBody = await JSON.parse(payloadHeader ?? "{}");
              this._transport?.handlePostRequest(req, parsedBody);
              break;
            }
            case "GET":
              this._transport?.handleGetRequest(req);
              break;
          }
        }
        break;
    }
  }

  /** Handles MCP Messages for both SSE and Streamable HTTP. */
  async onMessage(connection: Connection, event: WSMessage) {
    let message: JSONRPCMessage;
    try {
      // Ensure event is a string
      const data =
        typeof event === "string" ? event : new TextDecoder().decode(event);
      message = JSONRPCMessageSchema.parse(JSON.parse(data));
    } catch (error) {
      this._transport?.onerror?.(error as Error);
      return;
    }

    // Check if this is an elicitation response before passing to transport
    if (await this._handleElicitationResponse(message)) {
      return; // Message was handled by elicitation system
    }

    // Check if this is a sampling response before passing to transport
    if (await this._handleSamplingResponse(message)) {
      return; // Message was handled by sampling system
    }

    // Handle streamable-http specific logic
    if (this.getTransportType() === "streamable-http") {
      // Check if message is our control frame for the standalone SSE stream.
      if (
        isJSONRPCNotification(message) &&
        message.method === STANDALONE_SSE_METHOD
      ) {
        if (
          this._standaloneSseConnectionId &&
          this._standaloneSseConnectionId !== connection.id
        ) {
          // If the standalone SSE was already set, we close the old
          // socket to avoid dangling connections.
          const standaloneSseSocket = this.getConnection(
            this._standaloneSseConnectionId
          );
          standaloneSseSocket?.close(1000, "replaced");
        }
        connection.setState({
          role: STANDALONE_SSE_MARKER
        });

        this._standaloneSseConnectionId = connection.id;
        // This is internal, so we don't forward the message to the server.
        return;
      }

      // We need to map every incoming message to the connection that it came in on
      // so that we can send relevant responses and notifications back on the same connection
      if (isJSONRPCRequest(message)) {
        this._requestIdToConnectionId.set(message.id.toString(), connection.id);
      }
    }

    this._transport?.onmessage?.(message);
  }

  /** Remove clients from our cache when they disconnect */
  async onClose(
    conn: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // Remove the connection/socket mapping for the socket that just closed
    for (const [reqId, connId] of this._requestIdToConnectionId) {
      if (connId === conn.id) this._requestIdToConnectionId.delete(reqId);
    }

    // Clear the standalone SSE if it just closed
    if (this._standaloneSseConnectionId === conn.id) {
      this._standaloneSseConnectionId = undefined;
    }
  }

  /*
   * Transport ingress and routing
   */

  /** Handles MCP Messages for the legacy SSE transport. */
  async onSSEMcpMessage(
    _sessionId: string,
    messageBody: unknown
  ): Promise<Error | null> {
    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this.getTransportType() !== "sse") {
      return new Error("Internal Server Error: Expected SSE transport");
    }

    try {
      let parsedMessage: JSONRPCMessage;
      try {
        parsedMessage = JSONRPCMessageSchema.parse(messageBody);
      } catch (error) {
        this._transport?.onerror?.(error as Error);
        throw error;
      }

      // Check if this is an elicitation response before passing to transport
      if (await this._handleElicitationResponse(parsedMessage)) {
        return null; // Message was handled by elicitation system
      }

      // Check if this is a sampling response before passing to transport
      if (await this._handleSamplingResponse(parsedMessage)) {
        return null; // Message was handled by sampling system
      }

      this._transport?.onmessage?.(parsedMessage);
      return null;
    } catch (error) {
      console.error("Error forwarding message to SSE:", error);
      this._transport?.onerror?.(error as Error);
      return error as Error;
    }
  }

  /** Elicit user input with a message and schema */
  async elicitInput(params: {
    message: string;
    requestedSchema: unknown;
  }): Promise<ElicitResult> {
    const requestId = `elicit_${nanoid(8)}`;

    // Store request in durable storage
    const storedRequest: StoredElicitationRequest = {
      requestId,
      timestamp: Date.now(),
      type: "elicitation",
      message: params.message,
      requestedSchema: params.requestedSchema
    };
    await this._storeRequest(storedRequest, McpAgent.ELICITATION_REQUESTS_KEY);

    // Create promise with full timeout
    const elicitPromise = this._createPromise<ElicitResult>(
      requestId,
      McpAgent.REQUEST_TIMEOUT_MS,
      this._pendingElicitations,
      (id) =>
        this._removeRequest<StoredElicitationRequest>(
          id,
          McpAgent.ELICITATION_REQUESTS_KEY
        ),
      "Elicitation request timed out"
    );

    const elicitRequest = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "elicitation/create",
      params: {
        message: params.message,
        requestedSchema: params.requestedSchema
      }
    };

    // Send through MCP transport
    if (this._transport) {
      await this._transport.send(elicitRequest);
    } else {
      const connections = this.getConnections();
      if (!connections || Array.from(connections).length === 0) {
        await this._cleanupRequest<StoredElicitationRequest, ElicitResult>(
          requestId,
          this._pendingElicitations,
          McpAgent.ELICITATION_REQUESTS_KEY,
          "elicitation"
        );
        throw new Error(
          "No active WebSocket connections available for elicitation request"
        );
      }

      const connectionList = Array.from(connections);
      for (const connection of connectionList) {
        try {
          connection.send(JSON.stringify(elicitRequest));
        } catch (error) {
          console.error("Failed to send elicitation request:", error);
        }
      }
    }

    // Return the promise that will be resolved by _handleElicitationResponse
    return elicitPromise;
  }

  private async _cleanupRequest<T extends StoredRequest, R = unknown>(
    requestId: string,
    pendingMap: Map<
      string,
      {
        resolve: (result: R) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >,
    storageKey: string,
    requestType: string
  ): Promise<void> {
    const pending = pendingMap.get(requestId);
    if (pending) {
      try {
        clearTimeout(pending.timeout);
      } catch (error) {
        console.warn(
          `Failed to clear ${requestType} timeout for ${requestId}:`,
          error
        );
      }
      pendingMap.delete(requestId);
    }

    // Also remove from durable storage
    await this._removeRequest<T>(requestId, storageKey);
  }

  /** Create a message using client's LLM (sampling) */
  async createMessage(params: {
    messages: Array<{
      role: "user" | "assistant";
      content:
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string };
    }>;
    modelPreferences?: {
      hints?: Array<{ name?: string }>;
      costPriority?: number;
      speedPriority?: number;
      intelligencePriority?: number;
    };
    systemPrompt?: string;
    includeContext?: "none" | "thisServer" | "allServers";
    temperature?: number;
    maxTokens: number;
    stopSequences?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<SamplingResult> {
    const requestId = `sample_${nanoid(8)}`;

    // Store request in durable storage
    const storedRequest: StoredSamplingRequest = {
      requestId,
      timestamp: Date.now(),
      type: "sampling",
      params
    };
    await this._storeRequest(storedRequest, McpAgent.SAMPLING_REQUESTS_KEY);

    // Create promise with full timeout
    const samplingPromise = this._createPromise<SamplingResult>(
      requestId,
      McpAgent.REQUEST_TIMEOUT_MS,
      this._pendingSamplings,
      (id) =>
        this._removeRequest<StoredSamplingRequest>(
          id,
          McpAgent.SAMPLING_REQUESTS_KEY
        ),
      "Sampling request timed out"
    );

    const samplingRequest = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "sampling/createMessage",
      params
    };

    // Send through MCP transport
    if (this._transport) {
      await this._transport.send(samplingRequest);
    } else {
      const connections = this.getConnections();
      if (!connections || Array.from(connections).length === 0) {
        await this._cleanupRequest<StoredSamplingRequest, SamplingResult>(
          requestId,
          this._pendingSamplings,
          McpAgent.SAMPLING_REQUESTS_KEY,
          "sampling"
        );
        throw new Error(
          "No active WebSocket connections available for sampling request"
        );
      }

      const connectionList = Array.from(connections);
      for (const connection of connectionList) {
        try {
          connection.send(JSON.stringify(samplingRequest));
        } catch (error) {
          console.error("Failed to send sampling request:", error);
        }
      }
    }

    return samplingPromise;
  }

  private async _handleElicitationResponse(
    message: JSONRPCMessage
  ): Promise<boolean> {
    // Check if this is a response to an elicitation request
    if (isJSONRPCResponse(message) && message.result) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      const pending = this._pendingElicitations.get(requestId);
      if (!pending) {
        console.warn(
          `Received elicitation response for unknown request: ${requestId}`
        );
        return false;
      }

      await this._cleanupRequest<StoredElicitationRequest, ElicitResult>(
        requestId,
        this._pendingElicitations,
        McpAgent.ELICITATION_REQUESTS_KEY,
        "elicitation"
      );
      pending.resolve(message.result as ElicitResult);
      return true;
    }

    // Check if this is an error response to an elicitation request
    if (isJSONRPCError(message)) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      // Get pending promise
      const pending = this._pendingElicitations.get(requestId);
      if (!pending) {
        console.warn(
          `Received elicitation error for unknown request: ${requestId}`
        );
        return false;
      }

      // Resolve with error result
      await this._cleanupRequest<StoredElicitationRequest, ElicitResult>(
        requestId,
        this._pendingElicitations,
        McpAgent.ELICITATION_REQUESTS_KEY,
        "elicitation"
      );
      const errorResult: ElicitResult = {
        action: "cancel",
        content: {
          error: message.error.message || "Elicitation request failed"
        }
      };
      pending.resolve(errorResult);
      return true;
    }

    return false;
  }

  /** Handle sampling responses*/
  private async _handleSamplingResponse(
    message: JSONRPCMessage
  ): Promise<boolean> {
    // Check if this is a response to a sampling request
    if (isJSONRPCResponse(message) && message.result) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("sample_")) return false;

      const pending = this._pendingSamplings.get(requestId);
      if (!pending) {
        console.warn(
          `Received sampling response for unknown request: ${requestId}`
        );
        return false;
      }

      // Resolve the promise immediately
      await this._cleanupRequest<StoredSamplingRequest, SamplingResult>(
        requestId,
        this._pendingSamplings,
        McpAgent.SAMPLING_REQUESTS_KEY,
        "sampling"
      );
      pending.resolve(message.result as unknown as SamplingResult);
      return true;
    }

    // Check if this is an error response to a sampling request
    if (isJSONRPCError(message)) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("sample_")) return false;

      const pending = this._pendingSamplings.get(requestId);
      if (!pending) {
        console.warn(
          `Received sampling error for unknown request: ${requestId}`
        );
        return false;
      }

      // Reject with error
      await this._cleanupRequest<StoredSamplingRequest, SamplingResult>(
        requestId,
        this._pendingSamplings,
        McpAgent.SAMPLING_REQUESTS_KEY,
        "sampling"
      );
      pending.reject(
        new Error(message.error.message || "Sampling request failed")
      );
      return true;
    }

    return false;
  }

  /** Return a handler for the given path for this MCP.
   * Defaults to Streamable HTTP transport.
   */
  static serve(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions,
      transport = "streamable-http"
    }: ServeOptions = {}
  ) {
    return {
      async fetch<Env>(
        this: void,
        request: Request,
        env: Env,
        ctx: ExecutionContext
      ): Promise<Response> {
        // Handle CORS preflight
        const corsResponse = handleCORS(request, corsOptions);
        if (corsResponse) {
          return corsResponse;
        }

        const bindingValue = env[binding as keyof typeof env] as unknown;

        // Ensure we have a binding of some sort
        if (bindingValue == null || typeof bindingValue !== "object") {
          throw new Error(
            `Could not find McpAgent binding for ${binding}. Did you update your wrangler configuration?`
          );
        }

        // Ensure that the binding is to a DurableObject
        if (!isDurableObjectNamespace(bindingValue)) {
          throw new Error(
            `Invalid McpAgent binding for ${binding}. Make sure it's a Durable Object binding.`
          );
        }

        const namespace =
          bindingValue satisfies DurableObjectNamespace<McpAgent>;

        switch (transport) {
          case "streamable-http": {
            // Streamable HTTP transport handling
            const handleStreamableHttp = createStreamingHttpHandler(
              path,
              namespace,
              corsOptions
            );
            return handleStreamableHttp(request, ctx);
          }
          case "sse": {
            // Legacy SSE transport handling
            const handleLegacySse = createLegacySseHandler(
              path,
              namespace,
              corsOptions
            );
            return handleLegacySse(request, ctx);
          }
          default:
            return new Response(
              "Invalid MCP transport mode. Only `streamable-http` or `sse` are allowed.",
              { status: 500 }
            );
        }
      }
    };
  }
  /**
   * Legacy api
   **/
  static mount(path: string, opts: Omit<ServeOptions, "transport"> = {}) {
    return McpAgent.serveSSE(path, opts);
  }

  static serveSSE(path: string, opts: Omit<ServeOptions, "transport"> = {}) {
    return McpAgent.serve(path, { ...opts, transport: "sse" });
  }
}

// Export client transport classes
export { SSEEdgeClientTransport } from "./sse-edge";
export { StreamableHTTPEdgeClientTransport } from "./streamable-http-edge";

// Export elicitation types and schemas
export {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
