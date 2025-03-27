import { DurableObject } from "cloudflare:workers";
import { Agent } from "./";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connection } from "./";
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

export abstract class McpAgent<
    Env = unknown,
    State = unknown,
    Props extends Record<string, unknown> = Record<string, unknown>,
  >
  extends DurableObject<Env>
  implements Transport
{
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
    // websockets, hibernation, scheduling etc), let's only expose a couple of the methods
    // to the outer class for now.
    this.#agent = new (class extends Agent<Env, State> {
      static options = {
        hibernate: false,
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

  /**
   * McpAgent API
   */
  abstract server: McpServer;
  webSocket?: WebSocket;
  props!: Props;
  initRun = false;

  // Transport interface implementation. These are methods are going
  // to be added by the server
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  abstract init(): Promise<void>;

  async _init(props: Props) {
    this.props = props;
    if (!this.initRun) {
      this.initRun = true;
      await this.init();
    }
  }

  // Allow the worker to fetch a websocket connection to the agent
  async fetch(request: Request): Promise<Response> {
    // Only handle WebSocket upgrade requests
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket Upgrade request", {
        status: 400,
      });
    }

    // Create a WebSocket pair
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket with hibernation support
    this.ctx.acceptWebSocket(server);

    // Store the WebSocket
    this.webSocket = server;

    // Set up event handlers
    server.addEventListener("message", async (event) => {
      await this.webSocketMessage(server, event.data);
    });

    server.addEventListener("close", async (event) => {
      await this.webSocketClose(
        server,
        event.code || 1000,
        event.reason || "",
        event.wasClean || false
      );
    });

    server.addEventListener("error", async (event) => {
      await this.webSocketError(server, new Error("WebSocket error"));
    });

    // Connect to the MCP server
    await this.server.connect(this);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async onMCPMessage(request: Request): Promise<Response> {
    if (!this.webSocket) {
      return new Response("WebSocket not connected", { status: 500 });
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
      const body = await request.json();
      await this.handleMessage(body);
      return new Response("Accepted", { status: 202 });
    } catch (error) {
      this.onerror?.(error as Error);
      return new Response(String(error), { status: 400 });
    }
  }

  // Transport interface implementation
  async start(): Promise<void> {
    // WebSocket connection is established in fetch handler
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.webSocket) {
      throw new Error("WebSocket not connected");
    }

    try {
      this.webSocket.send(JSON.stringify(message));
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.webSocket) {
      try {
        this.webSocket.close();
      } catch (error) {
        // Ignore errors when closing
      }
      this.webSocket = undefined;
    }
    this.onclose?.();
  }

  // Process WebSocket messages
  async webSocketMessage(ws: WebSocket, event: ArrayBuffer | string) {
    let message: JSONRPCMessage;
    try {
      // Ensure event is a string
      const data =
        typeof event === "string" ? event : new TextDecoder().decode(event);
      message = JSONRPCMessageSchema.parse(JSON.parse(data));
    } catch (error) {
      this.onerror?.(error as Error);
      return;
    }

    this.onmessage?.(message);
  }

  // Handle message from any source
  async handleMessage(message: unknown): Promise<void> {
    let parsedMessage: JSONRPCMessage;
    try {
      parsedMessage = JSONRPCMessageSchema.parse(message);
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }

    this.onmessage?.(parsedMessage);
  }

  // WebSocket event handlers for hibernation support
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.onerror?.(error as Error);
    this.webSocket = undefined;
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.webSocket = undefined;
    this.onclose?.();
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
    const basePattern = new URLPattern({ pathname: path });
    const messagePattern = new URLPattern({ pathname: `${path}/message` });

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
          // Create a unique session ID for this connection
          const sessionId = namespace.newUniqueId().toString();

          // Create a Transform Stream for SSE
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();

          // Get the Durable Object
          const id = namespace.idFromString(sessionId);
          const doStub = namespace.get(id);

          // Initialize the object
          // @ts-ignore
          await doStub._init(ctx.props);

          // Connect to the Durable Object via WebSocket
          const response = await doStub.fetch(
            new Request(request.url, {
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
              // Send the message as an SSE event
              const messageText = `event: message\ndata: ${event.data}\n\n`;
              await writer.write(encoder.encode(messageText));
            } catch (error) {
              console.error("Error forwarding message to SSE:", error);
            }
          });

          // Handle WebSocket errors
          ws.addEventListener("error", async (error) => {
            console.error("WebSocket error:", error);
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
              `Missing sessionId. Expected POST to ${path} to initiate new one`,
              { status: 400 }
            );
          }

          // Get the Durable Object
          const object = namespace.get(namespace.idFromString(sessionId));

          // Forward the request to the Durable Object
          const response = await object.fetch(request);

          // Add CORS headers
          const headers = new Headers(response.headers);
          headers.set(
            "Access-Control-Allow-Origin",
            corsOptions?.origin || "*"
          );

          return new Response(response.body, {
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
