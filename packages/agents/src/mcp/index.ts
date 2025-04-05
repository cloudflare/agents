import { DurableObject } from "cloudflare:workers";
import { Agent } from "../";
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

class McpTransport implements Transport {
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

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends DurableObject<Env> {
  #status: "zero" | "starting" | "started" = "zero";
  #transport?: McpTransport;
  #connected = false;

  /**
   * Since McpAgent's _aren't_ yet real "Agents" (they route differently, don't support
   * websockets, don't support hibernation), let's only expose a couple of the methods
   * to the outer class: initialState/state/setState/onStateUpdate/sql
   */
  readonly #agent: Agent<Env, State>;

  protected constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const self = this;

    // Since McpAgent's _aren't_ yet real "Agents" (they route differently, they don't support
    // scheduling etc, let's only expose a couple of the methods
    // to the outer class for now.
    this.#agent = new (class extends Agent<Env, State> {
      static options = {
        hibernate: true,
      };

      onStateUpdate(state: State | undefined, source: Connection | "server") {
        return self.onStateUpdate(state, source);
      }
    })(ctx, env);
  }

  /**
   * Agents API allowlist
   */
  initialState!: State;
  get state() {
    if (this.initialState) this.#agent.initialState = this.initialState;
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
    this.props = (await this.ctx.storage.get("props")) as Props;
    this.init?.();

    // Connect to the MCP server
    this.#transport = new McpTransport(() => this.getWebSocket());
    await this.server.connect(this.#transport);
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
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }

    // Create a WebSocket pair
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // For now, each agent can only have one connection
    // If we get an upgrade while already connected, we should error
    if (this.#connected) {
      return new Response("WebSocket already connected", { status: 400 });
    }
    this.ctx.acceptWebSocket(server);
    this.#connected = true;

    // Connect to the MCP server
    this.#transport = new McpTransport(() => this.getWebSocket());
    await this.server.connect(this.#transport);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  getWebSocket() {
    const websockets = this.ctx.getWebSockets();
    if (websockets.length === 0) {
      return null;
    }
    return websockets[0];
  }

  async onMCPMessage(sessionId: string, request: Request): Promise<Response> {
    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }
    try {
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
        return new Response(`Request body too large: ${contentLength} bytes`, {
          status: 400,
        });
      }

      // Clone the request before reading the body to avoid stream issues
      const message = await request.json();
      let parsedMessage: JSONRPCMessage;
      try {
        parsedMessage = JSONRPCMessageSchema.parse(message);
      } catch (error) {
        this.#transport?.onerror?.(error as Error);
        throw error;
      }

      this.#transport?.onmessage?.(parsedMessage);
      return new Response("Accepted", { status: 202 });
    } catch (error) {
      this.#transport?.onerror?.(error as Error);
      return new Response(String(error), { status: 400 });
    }
  }

  // This is unused since there are no incoming websocket messages
  async webSocketMessage(ws: WebSocket, event: ArrayBuffer | string) {
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

    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }

    this.#transport?.onmessage?.(message);
  }

  // WebSocket event handlers for hibernation support
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (this.#status !== "started") {
      // This means the server "woke up" after hibernation
      // so we need to hydrate it again
      await this.#initialize();
    }
    this.#transport?.onerror?.(error as Error);
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
    this.#transport?.onclose?.();
    this.#connected = false;
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
    let pathname = path;
    if (path === "/") { pathname = "/*" }
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

        // Handle SSE connections
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
          const id = namespace.idFromString(sessionId);
          const doStub = namespace.get(id);

          // Initialize the object
          // @ts-ignore
          await doStub._init(ctx.props);

          // Connect to the Durable Object via WebSocket
          const upgradeUrl = new URL(request.url);
          upgradeUrl.searchParams.set("sessionId", sessionId);
          const response = await doStub.fetch(
            new Request(upgradeUrl, {
              headers: {
                Upgrade: "websocket",
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
              // https://www.jsonrpc.org/specification#response_object
              if (!(typeof message.id === "number" || message.id === null)) {
                throw new Error("Invalid jsonrpc message id");
              }

              if (message.jsonrpc !== "2.0") {
                throw new Error("Invalid jsonrpc version");
              }

              // must have either result or error field
              if (
                !Object.hasOwn(message, "result") &&
                !Object.hasOwn(message, "error")
              ) {
                throw new Error(
                  "Invalid jsonrpc message. Must have either result or error field"
                );
              }

              // Send the message as an SSE event
              const messageText = `event: message\ndata: ${event.data}\n\n`;
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

        // Handle MCP messages
        if (request.method === "POST" && messagePattern.test(url)) {
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            return new Response(
              `Missing sessionId. Expected POST to ${pathname} to initiate new one`,
              { status: 400 }
            );
          }

          // Get the Durable Object
          const object = namespace.get(namespace.idFromString(sessionId));

          // Forward the request to the Durable Object
          const response = await object.onMCPMessage(sessionId, request);

          // Add CORS headers
          const headers = new Headers();
          response.headers.forEach?.((value, key) => {
            headers.set(key, value);
          });
          headers.set(
            "Access-Control-Allow-Origin",
            corsOptions?.origin || "*"
          );

          return new Response(response.body as unknown as BodyInit, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    };
  }
}
