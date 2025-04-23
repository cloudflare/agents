import { DurableObject } from "cloudflare:workers";
import { Agent } from "../";
import type { WSMessage } from "../";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connection } from "../";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024; // 4MB

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

type TransportType = "sse" | "streamable" | "unset";

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends DurableObject<Env> {
  #status: "zero" | "starting" | "started" = "zero";
  #transport?: Transport;
  #transportType: TransportType = "unset";

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
    this.#transportType = (await this.ctx.storage.get(
      "transportType"
    )) as TransportType;
    this.init?.();

    // Connect to the MCP server
    if (this.#transportType === "sse") {
      this.#transport = new McpSSETransport(() => this.getWebSocket());
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
    await this.ctx.storage.put("transportType", "unset");
    this.props = props;
    if (!this.initRun) {
      this.initRun = true;
      await this.init();
    }
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

        // This connection must use the SSE protocol
        await this.ctx.storage.put("transportType", "sse");
        this.#transportType = "sse";

        // Connect to the MCP server
        if (!this.#transport) {
          this.#transport = new McpSSETransport(() => this.getWebSocket());
          await this.server.connect(this.#transport);
        }

        // Defer to the Agent's fetch method to handle the WebSocket connection
        return this.#agent.fetch(request);
      }
      default:
        return new Response("Internal Server Error: Expected /sse path", {
          status: 500,
        });
    }
  }

  getWebSocket() {
    const websockets = this.ctx.getWebSockets();
    if (websockets.length === 0) {
      return null;
    }
    return websockets[0];
  }

  // All messages received here. This is currently never called
  async onMessage(connection: Connection, event: WSMessage) {
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
    if (this.#transportType !== "sse") {
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
          if (contentLength > MAXIMUM_MESSAGE_SIZE) {
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
}
