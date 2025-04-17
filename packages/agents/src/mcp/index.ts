import { DurableObject } from "cloudflare:workers";
import { Agent } from "../";
import type { WSMessage } from "../";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connection } from "../";
import type {
  JSONRPCError,
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  InitializeRequestSchema,
  JSONRPCErrorSchema,
  JSONRPCMessageSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  JSONRPCResponseSchema,
} from "@modelcontextprotocol/sdk/types.js";

const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB

// CORS helper function
function handleCORS(
  request: Request,
  corsOptions?: CORSOptions
): Response | null {
  const origin = request.headers.get("Origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOptions?.origin || origin,
    "Access-Control-Allow-Methods":
      corsOptions?.methods || "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": corsOptions?.headers || "Content-Type",
    "Access-Control-Max-Age": (corsOptions?.maxAge || 86400).toString(),
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  return null;
}

interface CORSOptions {
  origin?: string;
  methods?: string;
  headers?: string;
  maxAge?: number;
}

type ParseMessageResult =
  | {
      type: "request";
      message: JSONRPCRequest;
      isInitializationRequest: boolean;
    }
  | {
      type: "notification";
      message: JSONRPCNotification;
    }
  | {
      type: "response";
      message: JSONRPCResponse;
    }
  | {
      type: "error";
      message: JSONRPCError;
    };

// TODO: Swap to https://github.com/modelcontextprotocol/typescript-sdk/pull/281
// when it gets released
function parseMessage(message: JSONRPCMessage): ParseMessageResult {
  const requestResult = JSONRPCRequestSchema.safeParse(message);
  if (requestResult.success) {
    return {
      type: "request",
      message: requestResult.data,
      isInitializationRequest:
        InitializeRequestSchema.safeParse(message).success,
    };
  }

  const notificationResult = JSONRPCNotificationSchema.safeParse(message);
  if (notificationResult.success) {
    return {
      type: "notification",
      message: notificationResult.data,
    };
  }

  const responseResult = JSONRPCResponseSchema.safeParse(message);
  if (responseResult.success) {
    return {
      type: "response",
      message: responseResult.data,
    };
  }

  const errorResult = JSONRPCErrorSchema.safeParse(message);
  if (errorResult.success) {
    return {
      type: "error",
      message: errorResult.data,
    };
  }

  // JSONRPCMessage is a union of these 4 types, so if we have a valid
  // JSONRPCMessage, we should not get this error
  throw new Error("Invalid message");
}

class McpSSETransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  #getWebSocket: () => WebSocket | null;
  #started = false;
  constructor(getWebSocket: () => WebSocket | null) {
    this.#getWebSocket = getWebSocket;
  }

  async start() {
    // The transport does not manage the WebSocket connection since it's terminated
    // by the Durable Object in order to allow hibernation. There's nothing to initialize.
    if (this.#started) {
      throw new Error("Transport already started");
    }
    this.#started = true;
  }

  async send(message: JSONRPCMessage) {
    if (!this.#started) {
      throw new Error("Transport not started");
    }
    const websocket = this.#getWebSocket();
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

class McpStreamableHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  // TODO: If there is an open connection to send server-initiated messages
  // back, we should use that connection
  #getWebSocketForGetRequest: () => WebSocket | null;

  // Get the appropriate websocket connection for a given message id
  #getWebSocketForMessageID: (id: string) => WebSocket | null;

  // Notify the server that a response has been sent for a given message id
  // so that it may clean up it's mapping of message ids to connections
  // once they are no longer needed
  #notifyResponseIdSent: (id: string) => void;

  #started = false;
  constructor(
    getWebSocketForMessageID: (id: string) => WebSocket | null,
    notifyResponseIdSent: (id: string | number) => void
  ) {
    this.#getWebSocketForMessageID = getWebSocketForMessageID;
    this.#notifyResponseIdSent = notifyResponseIdSent;
    // TODO
    this.#getWebSocketForGetRequest = () => null;
  }

  async start() {
    // The transport does not manage the WebSocket connection since it's terminated
    // by the Durable Object in order to allow hibernation. There's nothing to initialize.
    if (this.#started) {
      throw new Error("Transport already started");
    }
    this.#started = true;
  }

  async send(message: JSONRPCMessage) {
    if (!this.#started) {
      throw new Error("Transport not started");
    }

    let websocket: WebSocket | null = null;
    const parsedMessage = parseMessage(message);
    switch (parsedMessage.type) {
      // These types have an id
      case "response":
      case "error":
        websocket = this.#getWebSocketForMessageID(
          parsedMessage.message.id.toString()
        );
        if (!websocket) {
          throw new Error(
            `Could not find WebSocket for message id: ${parsedMessage.message.id}`
          );
        }
        break;
      // requests have an ID but are originated by the server so do not correspond to
      // any active connection
      case "request":
        websocket = this.#getWebSocketForGetRequest();
        break;
      // Notifications do not have an id
      case "notification":
        websocket = this.#getWebSocketForGetRequest();
        break;
    }

    try {
      websocket?.send(JSON.stringify(message));
      if (parsedMessage.type === "response") {
        this.#notifyResponseIdSent(parsedMessage.message.id.toString());
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

type Protocol = "sse" | "streamable-http" | "unset";

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends DurableObject<Env> {
  #status: "zero" | "starting" | "started" = "zero";
  #transport?: Transport;
  #protocol: Protocol = "unset";
  #requestIdToConnectionId: Map<string | number, string> = new Map();

  /**
   * Since McpAgent's _aren't_ yet real "Agents", let's only expose a couple of the methods
   * to the outer class: initialState/state/setState/onStateUpdate/sql
   */
  #agent: Agent<Env, State>;

  protected constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const self = this;

    this.#agent = new (class extends Agent<Env, State> {
      static options = {
        hibernate: true,
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
    return this.#agent.state;
  }
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) {
    return this.#agent.sql<T>(strings, ...values);
  }

  setState(state: State) {
    return this.#agent.setState(state);
  }
  onStateUpdate(state: State | undefined, source: Connection | "server") {
    // override this to handle state updates
  }
  async onStart() {
    const self = this;

    this.#agent = new (class extends Agent<Env, State> {
      initialState: State = self.initialState;
      static options = {
        hibernate: true,
      };

      onStateUpdate(state: State | undefined, source: Connection | "server") {
        return self.onStateUpdate(state, source);
      }

      async onMessage(connection: Connection, event: WSMessage) {
        return self.onMessage(connection, event);
      }
    })(this.ctx, this.env);

    this.props = (await this.ctx.storage.get("props")) as Props;
    this.#protocol = (await this.ctx.storage.get("protocol")) as Protocol;
    this.init?.();

    // Connect to the MCP server
    if (this.#protocol === "sse") {
      this.#transport = new McpSSETransport(() => this.getWebSocket());
      await this.server.connect(this.#transport);
    } else if (this.#protocol === "streamable-http") {
      this.#transport = new McpStreamableHttpTransport(
        (id) => this.getWebSocketForResponseID(id),
        (id) => this.#requestIdToConnectionId.delete(id)
      );
      await this.server.connect(this.#transport);
    }
  }

  /**
   * McpAgent API
   */
  abstract server: McpServer;
  props!: Props;
  initRun = false;

  abstract init(): Promise<void>;

  async _init(props: Props) {
    await this.ctx.storage.put("props", props);
    await this.ctx.storage.put("protocol", "unset");
    this.props = props;
    if (!this.initRun) {
      this.initRun = true;
      await this.init();
    }
  }

  isInitialized() {
    return this.initRun;
  }

  async #initialize(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.#status = "starting";
      await this.onStart();
      this.#status = "started";
    });
  }

  // Allow the worker to fetch a websocket connection to the agent
  async fetch(request: Request): Promise<Response> {
    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }

    // Only handle WebSocket upgrade requests
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket Upgrade request", {
        status: 400,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    switch (path) {
      // This session is going to communicate via the SSE protocol
      case "/sse": {
        // For SSE connections, we can only have one open connection per session
        // If we get an upgrade while already connected, we should error
        const websockets = this.ctx.getWebSockets();
        if (websockets.length > 0) {
          return new Response("Websocket already connected", { status: 400 });
        }

        // This session must use the SSE protocol
        await this.ctx.storage.put("protocol", "sse");
        this.#protocol = "sse";

        if (!this.#transport) {
          this.#transport = new McpSSETransport(() => this.getWebSocket());
          await this.server.connect(this.#transport);
        }

        // Defer to the Agent's fetch method to handle the WebSocket connection
        return this.#agent.fetch(request);
      }
      case "/streamable-http": {
        if (!this.#transport) {
          this.#transport = new McpStreamableHttpTransport(
            (id) => this.getWebSocketForResponseID(id),
            (id) => this.#requestIdToConnectionId.delete(id)
          );
          await this.server.connect(this.#transport);
        }

        // This session must use the streamable-http protocol
        await this.ctx.storage.put("protocol", "streamable-http");
        this.#protocol = "streamable-http";

        return this.#agent.fetch(request);
      }
      default:
        return new Response(
          "Internal Server Error: Expected /sse or /streamable-http path",
          {
            status: 500,
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
    const connectionId = this.#requestIdToConnectionId.get(id);
    if (connectionId === undefined) {
      return null;
    }
    return this.#agent.getConnection(connectionId) ?? null;
  }

  // All messages received here. This is currently never called
  async onMessage(connection: Connection, event: WSMessage) {
    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this.#protocol !== "streamable-http") {
      const err = new Error(
        "Internal Server Error: Expected streamable-http protocol"
      );
      this.#transport?.onerror?.(err);
      return;
    }

    let message: JSONRPCMessage;
    try {
      // Ensure event is a string
      const data =
        typeof event === "string" ? event : new TextDecoder().decode(event);
      message = JSONRPCMessageSchema.parse(JSON.parse(data));
    } catch (error) {
      this.#transport?.onerror?.(error as Error);
      return;
    }

    // We need to map every incoming message to the connection that it came in on
    // so that we can send relevant responses and notifications back on the same connection
    const parsedMessage = parseMessage(message);
    switch (parsedMessage.type) {
      case "request":
        this.#requestIdToConnectionId.set(
          parsedMessage.message.id.toString(),
          connection.id
        );
        break;
      case "response":
      case "notification":
      case "error":
        break;
    }

    this.#transport?.onmessage?.(message);
  }

  // All messages received over SSE after the initial connection has been established
  // will be passed here
  async onSSEMcpMessage(
    sessionId: string,
    request: Request
  ): Promise<Error | null> {
    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }

    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this.#protocol !== "sse") {
      return new Error("Internal Server Error: Expected SSE protocol");
    }

    try {
      const message = await request.json();
      let parsedMessage: JSONRPCMessage;
      try {
        parsedMessage = JSONRPCMessageSchema.parse(message);
      } catch (error) {
        this.#transport?.onerror?.(error as Error);
        throw error;
      }

      this.#transport?.onmessage?.(parsedMessage);
      return null;
    } catch (error) {
      this.#transport?.onerror?.(error as Error);
      return error as Error;
    }
  }

  // Delegate all websocket events to the underlying agent
  async webSocketMessage(
    ws: WebSocket,
    event: ArrayBuffer | string
  ): Promise<void> {
    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }
    return await this.#agent.webSocketMessage(ws, event);
  }

  // WebSocket event handlers for hibernation support
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }
    return await this.#agent.webSocketError(ws, error);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }
    return await this.#agent.webSocketClose(ws, code, reason, wasClean);
  }

  static mount(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions,
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
      corsOptions,
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
      fetch: async (
        request: Request,
        env: Record<string, DurableObjectNamespace<McpAgent>>,
        ctx: ExecutionContext
      ) => {
        // Handle CORS preflight
        const corsResponse = handleCORS(request, corsOptions);
        if (corsResponse) return corsResponse;

        const url = new URL(request.url);
        const namespace = env[binding];

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
          const endpointMessage = `event: endpoint\ndata: ${encodeURI(`${pathname}/message`)}?sessionId=${sessionId}\n\n`;
          writer.write(encoder.encode(endpointMessage));

          // Get the Durable Object
          const id = namespace.idFromName(`sse:${sessionId}`);
          const doStub = namespace.get(id);

          // Initialize the object
          await doStub._init(ctx.props);

          // Connect to the Durable Object via WebSocket
          const upgradeUrl = new URL(request.url);
          // enforce that the path that the DO receives is always /sse
          upgradeUrl.pathname = "/sse";
          const response = await doStub.fetch(
            new Request(upgradeUrl, {
              headers: {
                Upgrade: "websocket",
                // Required by PartyServer
                "x-partykit-room": sessionId,
              },
            })
          );

          // Get the WebSocket
          const ws = response.webSocket;
          if (!ws) {
            console.error("Failed to establish WebSocket connection");
            await writer.close();
            return;
          }

          // Accept the WebSocket
          ws.accept();

          // Handle messages from the Durable Object
          ws.addEventListener("message", async (event) => {
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
          });

          // Handle WebSocket errors
          ws.addEventListener("error", async (error) => {
            try {
              await writer.close();
            } catch (e) {
              // Ignore errors when closing
            }
          });

          // Handle WebSocket closure
          ws.addEventListener("close", async () => {
            try {
              await writer.close();
            } catch (error) {
              console.error("Error closing SSE connection:", error);
            }
          });

          // Return the SSE response
          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": corsOptions?.origin || "*",
            },
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
              status: 400,
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
                status: 400,
              }
            );
          }

          // Get the Durable Object
          const id = namespace.idFromName(`sse:${sessionId}`);
          const doStub = namespace.get(id);

          // Forward the request to the Durable Object
          const error = await doStub.onSSEMcpMessage(sessionId, request);

          if (error) {
            return new Response(error.message, {
              status: 400,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": corsOptions?.origin || "*",
              },
            });
          }

          return new Response("Accepted", {
            status: 202,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": corsOptions?.origin || "*",
            },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    };
  }

  static serve(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions,
    }: { binding?: string; corsOptions?: CORSOptions } = {}
  ) {
    let pathname = path;
    if (path === "/") {
      pathname = "/*";
    }
    const basePattern = new URLPattern({ pathname });

    return {
      fetch: async (
        request: Request,
        env: Record<string, DurableObjectNamespace<McpAgent>>,
        ctx: ExecutionContext
      ) => {
        // Handle CORS preflight
        const corsResponse = handleCORS(request, corsOptions);
        if (corsResponse) {
          return corsResponse;
        }

        const url = new URL(request.url);
        const namespace = env[binding];

        if (request.method === "POST" && basePattern.test(url)) {
          // validate the Accept header
          const acceptHeader = request.headers.get("accept");
          // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
          if (
            !acceptHeader?.includes("application/json") ||
            !acceptHeader.includes("text/event-stream")
          ) {
            const body = JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Not Acceptable: Client must accept application/json and text/event-stream",
              },
              id: null,
            });
            return new Response(body, { status: 406 });
          }

          const ct = request.headers.get("content-type");
          if (!ct || !ct.includes("application/json")) {
            const body = JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Unsupported Media Type: Content-Type must be application/json",
              },
              id: null,
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
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: `Request body too large. Maximum size is ${MAXIMUM_MESSAGE_SIZE_BYTES} bytes`,
              },
              id: null,
            });
            return new Response(body, { status: 413 });
          }

          let sessionId = request.headers.get("mcp-session-id");

          const rawMessage = await request.json();
          let messages: JSONRPCMessage[] = [];
          let parsedMessages: ParseMessageResult[] = [];

          // handle batch and single messages
          if (Array.isArray(rawMessage)) {
            messages = rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg));
          } else {
            messages = [JSONRPCMessageSchema.parse(rawMessage)];
          }
          parsedMessages = messages.map(parseMessage);

          // Before we pass the messages to the agent, there's another error condition we need to enforce
          // Check if this is an initialization request
          // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/
          const isInitializationRequest = parsedMessages.some(
            (msg) => msg.type === "request" && msg.isInitializationRequest
          );

          if (isInitializationRequest && sessionId) {
            const body = JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32600,
                message:
                  "Invalid Request: Initialization requests must not include a sessionId",
              },
              id: null,
            });
            return new Response(body, { status: 400 });
          }

          // The initialization request must be the only request in the batch
          if (isInitializationRequest && messages.length > 1) {
            const body = JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32600,
                message:
                  "Invalid Request: Only one initialization request is allowed",
              },
              id: null,
            });
            return new Response(body, { status: 400 });
          }

          // If an Mcp-Session-Id is returned by the server during initialization,
          // clients using the Streamable HTTP transport MUST include it
          // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
          if (!isInitializationRequest && !sessionId) {
            const body = JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32600,
                message: "Bad Request: Mcp-Session-Id header is required",
              },
              id: null,
            });
            return new Response(body, { status: 400 });
          }

          // If we don't have a sessionId, we are serving an initialization request
          // and need to generate a new sessionId
          sessionId = sessionId ?? namespace.newUniqueId().toString();

          // fetch the agent DO
          const id = namespace.idFromName(`streamable-http:${sessionId}`);
          const doStub = namespace.get(id);

          if (isInitializationRequest) {
            await doStub._init(ctx.props);
          } else if (!doStub.isInitialized()) {
            // if we have gotten here, then a session id that was never initialized
            // was provided
            const body = JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: "Session not found",
              },
              id: null,
            });
            return new Response(body, { status: 400 });
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
          const response = await doStub.fetch(
            new Request(upgradeUrl, {
              headers: {
                Upgrade: "websocket",
                // Required by PartyServer
                "x-partykit-room": sessionId,
              },
            })
          );

          // Get the WebSocket
          const ws = response.webSocket;
          if (!ws) {
            console.error("Failed to establish WebSocket connection");

            await writer.close();
            const body = JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: "Failed to establish WebSocket connection",
              },
              id: null,
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
          ws.addEventListener("message", async (event) => {
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

              // If the message is a response, add the id to the set of request ids
              const parsedMessage = parseMessage(result.data);
              switch (parsedMessage.type) {
                case "response":
                case "error":
                  requestIds.add(parsedMessage.message.id);
                  break;
                case "notification":
                case "request":
                  break;
              }

              // Send the message as an SSE event
              const messageText = `event: message\ndata: ${JSON.stringify(result.data)}\n\n`;
              await writer.write(encoder.encode(messageText));

              // If we have received all the responses, close the connection
              if (requestIds.size === messages.length) {
                ws.close();
              }
            } catch (error) {
              console.error("Error forwarding message to SSE:", error);
            }
          });

          // Handle WebSocket errors
          ws.addEventListener("error", async (error) => {
            try {
              await writer.close();
            } catch (e) {
              // Ignore errors when closing
            }
          });

          // Handle WebSocket closure
          ws.addEventListener("close", async () => {
            try {
              await writer.close();
            } catch (error) {
              console.error("Error closing SSE connection:", error);
            }
          });

          // If there are no requests, we send the messages to the agent and acknowledge the request with a 202
          // since we don't expect any responses back through this connection
          const hasOnlyNotificationsOrResponses = parsedMessages.every(
            (msg) => msg.type === "notification" || msg.type === "response"
          );
          if (hasOnlyNotificationsOrResponses) {
            for (const message of messages) {
              ws.send(JSON.stringify(message));
            }

            // closing the websocket will also close the SSE connection
            ws.close();

            return new Response(null, { status: 202 });
          }

          for (const message of messages) {
            const parsedMessage = parseMessage(message);
            switch (parsedMessage.type) {
              case "request":
                requestIds.add(parsedMessage.message.id);
                break;
              case "notification":
              case "response":
              case "error":
                break;
            }
            ws.send(JSON.stringify(message));
          }

          // Return the SSE response. We handle closing the stream in the ws "message"
          // handler
          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "mcp-session-id": sessionId,
              "Access-Control-Allow-Origin": corsOptions?.origin || "*",
            },
            status: 200,
          });
        }

        // We don't yet support GET or DELETE requests
        const body = JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed",
          },
          id: null,
        });
        return new Response(body, { status: 405 });
      },
    };
  }
}
