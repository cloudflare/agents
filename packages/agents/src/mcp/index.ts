import { DurableObject } from "cloudflare:workers";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  isJSONRPCError,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import type { Connection, WSMessage } from "../";
import { Agent } from "../index";

const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB

// CORS helper functions
function corsHeaders(_request: Request, corsOptions: CORSOptions = {}) {
  const origin = "*";
  return {
    "Access-Control-Allow-Headers":
      corsOptions.headers ||
      "Content-Type, mcp-session-id, mcp-protocol-version",
    "Access-Control-Allow-Methods": corsOptions.methods || "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": corsOptions.origin || origin,
    "Access-Control-Expose-Headers":
      corsOptions.exposeHeaders || "mcp-session-id",
    "Access-Control-Max-Age": (corsOptions.maxAge || 86400).toString()
  };
}

function isDurableObjectNamespace(
  namespace: unknown
): namespace is DurableObjectNamespace<McpAgent> {
  return (
    typeof namespace === "object" &&
    namespace !== null &&
    "newUniqueId" in namespace &&
    typeof namespace.newUniqueId === "function" &&
    "idFromName" in namespace &&
    typeof namespace.idFromName === "function"
  );
}

function handleCORS(
  request: Request,
  corsOptions?: CORSOptions
): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request, corsOptions) });
  }

  return null;
}

interface CORSOptions {
  origin?: string;
  methods?: string;
  headers?: string;
  maxAge?: number;
  exposeHeaders?: string;
}

class McpSSETransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

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
      throw error;
    }
  }

  async close() {
    // Similar to start, the only thing to do is to pass the event on to the server
    this.onclose?.();
  }
}

type TransportType = "sse" | "streamable-http" | "unset";

class McpStreamableHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  // TODO: If there is an open connection to send server-initiated messages
  // back, we should use that connection
  private _getWebSocketForGetRequest: () => WebSocket | null;

  // Get the appropriate websocket connection for a given message id
  private _getWebSocketForMessageID: (id: string) => WebSocket | null;

  // Notify the server that a response has been sent for a given message id
  // so that it may clean up it's mapping of message ids to connections
  // once they are no longer needed
  private _notifyResponseIdSent: (id: string) => void;

  private _started = false;
  constructor(
    getWebSocketForMessageID: (id: string) => WebSocket | null,
    notifyResponseIdSent: (id: string | number) => void
  ) {
    this._getWebSocketForMessageID = getWebSocketForMessageID;
    this._notifyResponseIdSent = notifyResponseIdSent;
    // TODO
    this._getWebSocketForGetRequest = () => null;
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

    let websocket: WebSocket | null = null;

    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      websocket = this._getWebSocketForMessageID(message.id.toString());
      if (!websocket) {
        throw new Error(
          `Could not find WebSocket for message id: ${message.id}`
        );
      }
    } else if (isJSONRPCRequest(message)) {
      // requests originating from the server must be sent over the
      // the connection created by a GET request
      websocket = this._getWebSocketForGetRequest();
    } else if (isJSONRPCNotification(message)) {
      // notifications do not have an id
      // but do have a relatedRequestId field
      // so that they can be sent to the correct connection
      websocket = null;
    }

    try {
      websocket?.send(JSON.stringify(message));
      if (isJSONRPCResponse(message)) {
        this._notifyResponseIdSent(message.id.toString());
      }
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }
  }

  async close() {
    // Similar to start, the only thing to do is to pass the event on to the server
    this.onclose?.();
  }
}

type MaybePromise<T> = T | Promise<T>;

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends DurableObject<Env> {
  private _status: "zero" | "starting" | "started" = "zero";
  private _transport?: Transport;
  private _transportType: TransportType = "unset";
  private _requestIdToConnectionId: Map<string | number, string> = new Map();

  // Hibernation-safe elicitation handling
  // Uses durable storage instead of in-memory handlers

  /**
   * Since McpAgent's _aren't_ yet real "Agents", let's only expose a couple of the methods
   * to the outer class: initialState/state/setState/onStateUpdate/sql
   */
  private _agent: Agent<Env, State>;

  get mcp() {
    return this._agent.mcp;
  }

  protected constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const self = this;

    this._agent = new (class extends Agent<Env, State> {
      static options = {
        hibernate: true
      };

      onStateUpdate(state: State | undefined, source: Connection | "server") {
        return self.onStateUpdate(state, source);
      }

      async onMessage(
        connection: Connection,
        message: WSMessage
      ): Promise<void> {
        return self.onMessage(connection, message);
      }
    })(ctx, env);
  }

  /**
   * Agents API allowlist
   */
  initialState!: State;
  get state() {
    return this._agent.state;
  }
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) {
    return this._agent.sql<T>(strings, ...values);
  }

  setState(state: State) {
    return this._agent.setState(state);
  }

  /**
   * Elicit user input with a message and schema
   */
  async elicitInput(params: {
    message: string;
    requestedSchema: unknown;
  }): Promise<ElicitResult> {
    const requestId = `elicit_${Math.random().toString(36).substring(2, 11)}`;

    // Store pending request in durable storage
    await this.ctx.storage.put(`elicitation:${requestId}`, {
      message: params.message,
      requestedSchema: params.requestedSchema,
      timestamp: Date.now()
    });

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
      const connections = this._agent?.getConnections();
      if (!connections || Array.from(connections).length === 0) {
        await this.ctx.storage.delete(`elicitation:${requestId}`);
        throw new Error("No active connections available for elicitation");
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

    // Wait for response through MCP
    return this._waitForElicitationResponse(requestId);
  }

  // we leave the variables as unused for autocomplete purposes
  // biome-ignore lint/correctness/noUnusedFunctionParameters: overriden later
  onStateUpdate(state: State | undefined, source: Connection | "server") {
    // override this to handle state updates
  }
  async onStart() {
    const self = this;

    this._agent = new (class extends Agent<Env, State> {
      initialState: State = self.initialState;
      static options = {
        hibernate: true
      };

      onStateUpdate(state: State | undefined, source: Connection | "server") {
        return self.onStateUpdate(state, source);
      }

      async onMessage(connection: Connection, event: WSMessage) {
        return self.onMessage(connection, event);
      }
    })(this.ctx, this.env);

    this.props = (await this.ctx.storage.get("props")) as Props;
    this._transportType = (await this.ctx.storage.get(
      "transportType"
    )) as TransportType;
    await this._init(this.props);

    const server = await this.server;

    // Connect to the MCP server
    if (this._transportType === "sse") {
      this._transport = new McpSSETransport(() => this.getWebSocket());
      await server.connect(this._transport);
    } else if (this._transportType === "streamable-http") {
      this._transport = new McpStreamableHttpTransport(
        (id) => this.getWebSocketForResponseID(id),
        (id) => this._requestIdToConnectionId.delete(id)
      );
      await server.connect(this._transport);
    }
  }

  /**
   * McpAgent API
   */
  abstract server: MaybePromise<McpServer | Server>;
  props!: Props;
  initRun = false;

  abstract init(): Promise<void>;

  /**
   * Handle errors that occur during initialization or operation.
   * Override this method to provide custom error handling.
   * @param error - The error that occurred
   * @returns An error response object with status code and message
   */
  onError(error: Error): { status: number; message: string } {
    console.error("McpAgent error:", error);
    return {
      status: 500,
      message:
        error.message || "An unexpected error occurred during initialization"
    };
  }

  async _init(props: Props) {
    await this.updateProps(props);
    if (!this.ctx.storage.get("transportType")) {
      await this.ctx.storage.put("transportType", "unset");
    }
    if (!this.initRun) {
      this.initRun = true;
      try {
        await this.init();
      } catch (error) {
        const errorResponse = this.onError(error as Error);
        throw new Error(`Initialization failed: ${errorResponse.message}`);
      }
    }
  }

  async setInitialized() {
    await this.ctx.storage.put("initialized", true);
  }

  async isInitialized() {
    return (await this.ctx.storage.get("initialized")) === true;
  }

  async updateProps(props: Props) {
    await this.ctx.storage.put("props", props ?? {});
    this.props = props;
  }

  private async _initialize(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this._status = "starting";
      await this.onStart();
      this._status = "started";
    });
  }

  // Allow the worker to fetch a websocket connection to the agent
  async fetch(request: Request): Promise<Response> {
    if (this._status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this._initialize();
    }

    // Only handle WebSocket upgrade requests
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket Upgrade request", {
        status: 400
      });
    }

    // This request does not come from the user. The worker generates this
    // request to generate a websocket connection to the agent.
    const url = new URL(request.url);
    // This is not the path that the user requested, but the path that the worker
    // generated. We'll use this path to determine which transport to use.
    const path = url.pathname;
    const server = await this.server;

    switch (path) {
      case "/sse": {
        // For SSE connections, we can only have one open connection per session
        // If we get an upgrade while already connected, we should error
        const websockets = this.ctx.getWebSockets();
        if (websockets.length > 0) {
          return new Response("Websocket already connected", { status: 400 });
        }

        // This session must always use the SSE transporo
        await this.ctx.storage.put("transportType", "sse");
        this._transportType = "sse";

        if (!this._transport) {
          this._transport = new McpSSETransport(() => this.getWebSocket());
          await server.connect(this._transport);
        }

        // Defer to the Agent's fetch method to handle the WebSocket connection
        return this._agent.fetch(request);
      }
      case "/streamable-http": {
        if (!this._transport) {
          this._transport = new McpStreamableHttpTransport(
            (id) => this.getWebSocketForResponseID(id),
            (id) => this._requestIdToConnectionId.delete(id)
          );
          await server.connect(this._transport);
        }

        // This session must always use the streamable-http transport
        await this.ctx.storage.put("transportType", "streamable-http");
        this._transportType = "streamable-http";

        return this._agent.fetch(request);
      }
      default:
        return new Response(
          "Internal Server Error: Expected /sse or /streamable-http path",
          {
            status: 500
          }
        );
    }
  }

  getWebSocket() {
    const websockets = this.ctx.getWebSockets();
    if (websockets.length === 0) {
      return null;
    }
    return websockets[0];
  }

  getWebSocketForResponseID(id: string): WebSocket | null {
    const connectionId = this._requestIdToConnectionId.get(id);
    if (connectionId === undefined) {
      return null;
    }
    return this._agent.getConnection(connectionId) ?? null;
  }

  // All messages received here. This is currently never called
  async onMessage(connection: Connection, event: WSMessage) {
    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this._transportType !== "streamable-http") {
      const err = new Error(
        "Internal Server Error: Expected streamable-http protocol"
      );
      this._transport?.onerror?.(err);
      return;
    }

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

    // We need to map every incoming message to the connection that it came in on
    // so that we can send relevant responses and notifications back on the same connection
    if (isJSONRPCRequest(message)) {
      this._requestIdToConnectionId.set(message.id.toString(), connection.id);
    }

    this._transport?.onmessage?.(message);
  }

  /**
   * Wait for elicitation response through storage polling
   */
  private async _waitForElicitationResponse(
    requestId: string
  ): Promise<ElicitResult> {
    const startTime = Date.now();
    const timeout = 60000; // 60 second timeout

    try {
      while (Date.now() - startTime < timeout) {
        // Check if response has been stored
        const response = await this.ctx.storage.get<ElicitResult>(
          `elicitation:response:${requestId}`
        );
        if (response) {
          // Immediately clean up both request and response
          await this.ctx.storage.delete(`elicitation:${requestId}`);
          await this.ctx.storage.delete(`elicitation:response:${requestId}`);
          return response;
        }

        // Sleep briefly before checking again
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      throw new Error("Elicitation request timed out");
    } finally {
      // Always clean up on timeout or error
      await this.ctx.storage.delete(`elicitation:${requestId}`);
      await this.ctx.storage.delete(`elicitation:response:${requestId}`);
    }
  }

  /**
   * Handle elicitation responses   */
  private async _handleElicitationResponse(
    message: JSONRPCMessage
  ): Promise<boolean> {
    // Check if this is a response to an elicitation request
    if (isJSONRPCResponse(message) && message.result) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      // Check if we have a pending request for this ID
      const pendingRequest = await this.ctx.storage.get(
        `elicitation:${requestId}`
      );
      if (!pendingRequest) return false;

      // Store the response in durable storage
      await this.ctx.storage.put(
        `elicitation:response:${requestId}`,
        message.result as ElicitResult
      );
      return true;
    }

    // Check if this is an error response to an elicitation request
    if (isJSONRPCError(message)) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      // Check if we have a pending request for this ID
      const pendingRequest = await this.ctx.storage.get(
        `elicitation:${requestId}`
      );
      if (!pendingRequest) return false;

      // Store error response
      const errorResult: ElicitResult = {
        action: "cancel",
        content: {
          error: message.error.message || "Elicitation request failed"
        }
      };
      await this.ctx.storage.put(
        `elicitation:response:${requestId}`,
        errorResult
      );
      return true;
    }

    return false;
  }

  // All messages received over SSE after the initial connection has been established
  // will be passed here
  async onSSEMcpMessage(
    _sessionId: string,
    messageBody: unknown
  ): Promise<Error | null> {
    if (this._status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this._initialize();
    }

    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this._transportType !== "sse") {
      return new Error("Internal Server Error: Expected SSE protocol");
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

      this._transport?.onmessage?.(parsedMessage);
      return null;
    } catch (error) {
      console.error("Error forwarding message to SSE:", error);
      this._transport?.onerror?.(error as Error);
      return error as Error;
    }
  }

  // Delegate all websocket events to the underlying agent
  async webSocketMessage(
    ws: WebSocket,
    event: ArrayBuffer | string
  ): Promise<void> {
    if (this._status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this._initialize();
    }
    return await this._agent.webSocketMessage(ws, event);
  }

  // WebSocket event handlers for hibernation support
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (this._status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this._initialize();
    }
    return await this._agent.webSocketError(ws, error);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    if (this._status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this._initialize();
    }
    return await this._agent.webSocketClose(ws, code, reason, wasClean);
  }

  static mount(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions
    }: {
      binding?: string;
      corsOptions?: CORSOptions;
    } = {}
  ) {
    return McpAgent.serveSSE(path, { binding, corsOptions });
  }

  static serveSSE(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions
    }: {
      binding?: string;
      corsOptions?: CORSOptions;
    } = {}
  ) {
    let pathname = path;
    if (path === "/") {
      pathname = "/*";
    }
    const basePattern = new URLPattern({ pathname });
    const messagePattern = new URLPattern({ pathname: `${pathname}/message` });

    return {
      async fetch<Env>(
        this: void,
        request: Request,
        env: Env,
        ctx: ExecutionContext
      ): Promise<Response> {
        // Handle CORS preflight
        const corsResponse = handleCORS(request, corsOptions);
        if (corsResponse) return corsResponse;

        const url = new URL(request.url);
        const bindingValue = env[binding as keyof typeof env] as unknown;

        // Ensure we have a binding of some sort
        if (bindingValue == null || typeof bindingValue !== "object") {
          console.error(
            `Could not find McpAgent binding for ${binding}. Did you update your wrangler configuration?`
          );
          return new Response("Invalid binding", { status: 500 });
        }

        // Ensure that the binding is to a DurableObject
        if (!isDurableObjectNamespace(bindingValue)) {
          return new Response("Invalid binding", { status: 500 });
        }

        const namespace =
          bindingValue satisfies DurableObjectNamespace<McpAgent>;

        // Handle initial SSE connection
        if (request.method === "GET" && basePattern.test(url)) {
          // Use a session ID if one is passed in, or create a unique
          // session ID for this connection
          const sessionId =
            url.searchParams.get("sessionId") ||
            namespace.newUniqueId().toString();

          // Create a Transform Stream for SSE
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();

          // Send the endpoint event
          const endpointUrl = new URL(request.url);
          endpointUrl.pathname = encodeURI(`${pathname}/message`);
          endpointUrl.searchParams.set("sessionId", sessionId);
          const relativeUrlWithSession =
            endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;
          const endpointMessage = `event: endpoint\ndata: ${relativeUrlWithSession}\n\n`;
          writer.write(encoder.encode(endpointMessage));

          // Get the Durable Object
          const id = namespace.idFromName(`sse:${sessionId}`);
          const doStub = namespace.get(id);

          // Initialize the object
          try {
            await doStub._init(ctx.props);
          } catch (error) {
            console.error("Failed to initialize McpAgent:", error);
            await writer.close();
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            return new Response(`Initialization failed: ${errorMessage}`, {
              status: 500
            });
          }

          // Connect to the Durable Object via WebSocket
          const upgradeUrl = new URL(request.url);
          // enforce that the path that the DO receives is always /sse
          upgradeUrl.pathname = "/sse";
          const existingHeaders: Record<string, string> = {};
          request.headers.forEach((value, key) => {
            existingHeaders[key] = value;
          });
          const response = await doStub.fetch(
            new Request(upgradeUrl, {
              headers: {
                ...existingHeaders,
                Upgrade: "websocket",
                // Required by PartyServer
                "x-partykit-room": sessionId
              }
            })
          );

          // Get the WebSocket
          const ws = response.webSocket;
          if (!ws) {
            console.error("Failed to establish WebSocket connection");
            await writer.close();
            return new Response("Failed to establish WebSocket connection", {
              status: 500
            });
          }

          // Accept the WebSocket
          ws.accept();

          // Handle messages from the Durable Object
          ws.addEventListener("message", (event) => {
            async function onMessage(event: MessageEvent) {
              try {
                const message = JSON.parse(event.data);

                // validate that the message is a valid JSONRPC message
                const result = JSONRPCMessageSchema.safeParse(message);
                if (!result.success) {
                  // The message was not a valid JSONRPC message, so we will drop it
                  // PartyKit will broadcast state change messages to all connected clients
                  // and we need to filter those out so they are not passed to MCP clients
                  return;
                }

                // Send the message as an SSE event
                const messageText = `event: message\ndata: ${JSON.stringify(result.data)}\n\n`;
                await writer.write(encoder.encode(messageText));
              } catch (error) {
                console.error("Error forwarding message to SSE:", error);
              }
            }
            onMessage(event).catch(console.error);
          });

          // Handle WebSocket errors
          ws.addEventListener("error", (error) => {
            async function onError(_error: Event) {
              try {
                await writer.close();
              } catch (_e) {
                // Ignore errors when closing
              }
            }
            onError(error).catch(console.error);
          });

          // Handle WebSocket closure
          ws.addEventListener("close", () => {
            async function onClose() {
              try {
                await writer.close();
              } catch (error) {
                console.error("Error closing SSE connection:", error);
              }
            }
            onClose().catch(console.error);
          });

          // Return the SSE response
          return new Response(readable, {
            headers: {
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream",
              ...corsHeaders(request, corsOptions)
            }
          });
        }

        // Handle incoming MCP messages. These will be passed to McpAgent
        // but the response will be sent back via the open SSE connection
        // so we only need to return a 202 Accepted response for success
        if (request.method === "POST" && messagePattern.test(url)) {
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            return new Response(
              `Missing sessionId. Expected POST to ${pathname} to initiate new one`,
              { status: 400 }
            );
          }

          const contentType = request.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) {
            return new Response(`Unsupported content-type: ${contentType}`, {
              status: 400
            });
          }

          // check if the request body is too large
          const contentLength = Number.parseInt(
            request.headers.get("content-length") || "0",
            10
          );
          if (contentLength > MAXIMUM_MESSAGE_SIZE_BYTES) {
            return new Response(
              `Request body too large: ${contentLength} bytes`,
              {
                status: 400
              }
            );
          }

          // Get the Durable Object
          const id = namespace.idFromName(`sse:${sessionId}`);
          const doStub = namespace.get(id);

          const messageBody = await request.json();
          // Update props with fresh values before processing message
          await doStub.updateProps(ctx.props);
          const error = await doStub.onSSEMcpMessage(sessionId, messageBody);

          if (error) {
            return new Response(error.message, {
              headers: {
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream",
                ...corsHeaders(request, corsOptions)
              },
              status: 400
            });
          }

          return new Response("Accepted", {
            headers: {
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream",
              ...corsHeaders(request, corsOptions)
            },
            status: 202
          });
        }

        return new Response("Not Found", { status: 404 });
      }
    };
  }

  static serve(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions
    }: { binding?: string; corsOptions?: CORSOptions } = {}
  ) {
    let pathname = path;
    if (path === "/") {
      pathname = "/*";
    }
    const basePattern = new URLPattern({ pathname });

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

        const url = new URL(request.url);
        const bindingValue = env[binding as keyof typeof env] as unknown;

        // Ensure we have a binding of some sort
        if (bindingValue == null || typeof bindingValue !== "object") {
          console.error(
            `Could not find McpAgent binding for ${binding}. Did you update your wrangler configuration?`
          );
          return new Response("Invalid binding", { status: 500 });
        }

        // Ensure that the binding is to a DurableObject
        if (!isDurableObjectNamespace(bindingValue)) {
          return new Response("Invalid binding", { status: 500 });
        }

        const namespace =
          bindingValue satisfies DurableObjectNamespace<McpAgent>;

        if (request.method === "POST" && basePattern.test(url)) {
          // validate the Accept header
          const acceptHeader = request.headers.get("accept");
          // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
          if (
            !acceptHeader?.includes("application/json") ||
            !acceptHeader.includes("text/event-stream")
          ) {
            const body = JSON.stringify({
              error: {
                code: -32000,
                message:
                  "Not Acceptable: Client must accept both application/json and text/event-stream"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 406 });
          }

          const ct = request.headers.get("content-type");
          if (!ct || !ct.includes("application/json")) {
            const body = JSON.stringify({
              error: {
                code: -32000,
                message:
                  "Unsupported Media Type: Content-Type must be application/json"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 415 });
          }

          // Check content length against maximum allowed size
          const contentLength = Number.parseInt(
            request.headers.get("content-length") ?? "0",
            10
          );
          if (contentLength > MAXIMUM_MESSAGE_SIZE_BYTES) {
            const body = JSON.stringify({
              error: {
                code: -32000,
                message: `Request body too large. Maximum size is ${MAXIMUM_MESSAGE_SIZE_BYTES} bytes`
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 413 });
          }

          let sessionId = request.headers.get("mcp-session-id");
          let rawMessage: unknown;

          try {
            rawMessage = await request.json();
          } catch (_error) {
            const body = JSON.stringify({
              error: {
                code: -32700,
                message: "Parse error: Invalid JSON"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 400 });
          }

          // Make sure the message is an array to simplify logic
          let arrayMessage: unknown[];
          if (Array.isArray(rawMessage)) {
            arrayMessage = rawMessage;
          } else {
            arrayMessage = [rawMessage];
          }

          let messages: JSONRPCMessage[] = [];

          // Try to parse each message as JSON RPC. Fail if any message is invalid
          for (const msg of arrayMessage) {
            if (!JSONRPCMessageSchema.safeParse(msg).success) {
              const body = JSON.stringify({
                error: {
                  code: -32700,
                  message: "Parse error: Invalid JSON-RPC message"
                },
                id: null,
                jsonrpc: "2.0"
              });
              return new Response(body, { status: 400 });
            }
          }

          messages = arrayMessage.map((msg) => JSONRPCMessageSchema.parse(msg));

          // Before we pass the messages to the agent, there's another error condition we need to enforce
          // Check if this is an initialization request
          // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/
          const isInitializationRequest = messages.some(
            (msg) => InitializeRequestSchema.safeParse(msg).success
          );

          if (isInitializationRequest && sessionId) {
            const body = JSON.stringify({
              error: {
                code: -32600,
                message:
                  "Invalid Request: Initialization requests must not include a sessionId"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 400 });
          }

          // The initialization request must be the only request in the batch
          if (isInitializationRequest && messages.length > 1) {
            const body = JSON.stringify({
              error: {
                code: -32600,
                message:
                  "Invalid Request: Only one initialization request is allowed"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 400 });
          }

          // If an Mcp-Session-Id is returned by the server during initialization,
          // clients using the Streamable HTTP transport MUST include it
          // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
          if (!isInitializationRequest && !sessionId) {
            const body = JSON.stringify({
              error: {
                code: -32000,
                message: "Bad Request: Mcp-Session-Id header is required"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 400 });
          }

          // If we don't have a sessionId, we are serving an initialization request
          // and need to generate a new sessionId
          sessionId = sessionId ?? namespace.newUniqueId().toString();

          // fetch the agent DO
          const id = namespace.idFromName(`streamable-http:${sessionId}`);
          const doStub = namespace.get(id);
          const isInitialized = await doStub.isInitialized();

          if (isInitializationRequest) {
            try {
              await doStub._init(ctx.props);
              await doStub.setInitialized();
            } catch (error) {
              console.error("Failed to initialize McpAgent:", error);
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const body = JSON.stringify({
                error: {
                  code: -32001,
                  message: `Initialization failed: ${errorMessage}`
                },
                id: null,
                jsonrpc: "2.0"
              });
              return new Response(body, { status: 500 });
            }
          } else if (!isInitialized) {
            // if we have gotten here, then a session id that was never initialized
            // was provided
            const body = JSON.stringify({
              error: {
                code: -32001,
                message: "Session not found"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 404 });
          } else {
            // Update props for existing sessions
            await doStub.updateProps(ctx.props);
          }

          // We've evaluated all the error conditions! Now it's time to establish
          // all the streams

          // Create a Transform Stream for SSE
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();

          // Connect to the Durable Object via WebSocket
          const upgradeUrl = new URL(request.url);
          upgradeUrl.pathname = "/streamable-http";
          const existingHeaders: Record<string, string> = {};
          request.headers.forEach((value, key) => {
            existingHeaders[key] = value;
          });
          const response = await doStub.fetch(
            new Request(upgradeUrl, {
              headers: {
                ...existingHeaders,
                Upgrade: "websocket",
                // Required by PartyServer
                "x-partykit-room": sessionId
              }
            })
          );

          // Get the WebSocket
          const ws = response.webSocket;
          if (!ws) {
            console.error("Failed to establish WebSocket connection");

            await writer.close();
            const body = JSON.stringify({
              error: {
                code: -32001,
                message: "Failed to establish WebSocket connection"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 500 });
          }

          // Keep track of the request ids that we have sent to the server
          // so that we can close the connection once we have received
          // all the responses
          const requestIds: Set<string | number> = new Set();

          // Accept the WebSocket
          ws.accept();

          // Handle messages from the Durable Object
          ws.addEventListener("message", (event) => {
            async function onMessage(event: MessageEvent) {
              try {
                const data =
                  typeof event.data === "string"
                    ? event.data
                    : new TextDecoder().decode(event.data);
                const message = JSON.parse(data);

                // validate that the message is a valid JSONRPC message
                const result = JSONRPCMessageSchema.safeParse(message);
                if (!result.success) {
                  // The message was not a valid JSONRPC message, so we will drop it
                  // PartyKit will broadcast state change messages to all connected clients
                  // and we need to filter those out so they are not passed to MCP clients
                  return;
                }

                // If the message is a response or an error, remove the id from the set of
                // request ids
                if (
                  isJSONRPCResponse(result.data) ||
                  isJSONRPCError(result.data)
                ) {
                  requestIds.delete(result.data.id);
                }

                // Send the message as an SSE event
                const messageText = `event: message\ndata: ${JSON.stringify(result.data)}\n\n`;
                await writer.write(encoder.encode(messageText));

                // If we have received all the responses, close the connection
                if (requestIds.size === 0) {
                  ws!.close();
                }
              } catch (error) {
                console.error("Error forwarding message to SSE:", error);
              }
            }
            onMessage(event).catch(console.error);
          });

          // Handle WebSocket errors
          ws.addEventListener("error", (error) => {
            async function onError(_error: Event) {
              try {
                await writer.close();
              } catch (_e) {
                // Ignore errors when closing
              }
            }
            onError(error).catch(console.error);
          });

          // Handle WebSocket closure
          ws.addEventListener("close", () => {
            async function onClose() {
              try {
                await writer.close();
              } catch (error) {
                console.error("Error closing SSE connection:", error);
              }
            }
            onClose().catch(console.error);
          });

          // If there are no requests, we send the messages to the agent and acknowledge the request with a 202
          // since we don't expect any responses back through this connection
          const hasOnlyNotificationsOrResponses = messages.every(
            (msg) => isJSONRPCNotification(msg) || isJSONRPCResponse(msg)
          );
          if (hasOnlyNotificationsOrResponses) {
            for (const message of messages) {
              ws.send(JSON.stringify(message));
            }

            // closing the websocket will also close the SSE connection
            ws.close();

            return new Response(null, {
              headers: corsHeaders(request, corsOptions),
              status: 202
            });
          }

          for (const message of messages) {
            if (isJSONRPCRequest(message)) {
              // add each request id that we send off to a set
              // so that we can keep track of which requests we
              // still need a response for
              requestIds.add(message.id);
            }
            ws.send(JSON.stringify(message));
          }

          // Return the SSE response. We handle closing the stream in the ws "message"
          // handler
          return new Response(readable, {
            headers: {
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream",
              "mcp-session-id": sessionId,
              ...corsHeaders(request, corsOptions)
            },
            status: 200
          });
        }

        // We don't yet support GET or DELETE requests
        const body = JSON.stringify({
          error: {
            code: -32000,
            message: "Method not allowed"
          },
          id: null,
          jsonrpc: "2.0"
        });
        return new Response(body, { status: 405 });
      }
    };
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
