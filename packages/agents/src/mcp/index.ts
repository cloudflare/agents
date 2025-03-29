import { DurableObject } from "cloudflare:workers";
import { Agent } from "../";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEEdgeServerTransport } from "./sse-edge";
import type { Connection } from "../";

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
> extends DurableObject<Env> {
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
  private transport!: SSEEdgeServerTransport;
  props!: Props;
  initRun = false;

  abstract init(): Promise<void>;

  async _init(props: Props) {
    this.props = props;
    if (!this.initRun) {
      this.initRun = true;
      await this.init();
    }
  }

  async onSSE(path: string): Promise<Response> {
    this.transport = new SSEEdgeServerTransport(
      `${path}/message`,
      this.ctx.id.toString()
    );
    await this.server.connect(this.transport);
    return this.transport.sseResponse;
  }

  async onMCPMessage(request: Request): Promise<Response> {
    return this.transport.handlePostMessage(request);
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

        if (request.method === "GET" && basePattern.test(url)) {
          const object = namespace.get(namespace.newUniqueId());
          // @ts-ignore
          await object._init(ctx.props);
          const response = await object.onSSE(path);

          // Convert headers to a plain object
          const headerObj: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headerObj[key] = value;
          });
          headerObj["Access-Control-Allow-Origin"] = corsOptions?.origin || "*";

          // Clone the response to get a new body stream
          // const clonedResponse = response.clone();
          return new Response(response.body as unknown as BodyInit, {
            status: response.status,
            statusText: response.statusText,
            headers: headerObj,
          });
        }

        if (request.method === "POST" && messagePattern.test(url)) {
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            return new Response(
              `Missing sessionId. Expected POST to ${path} to initiate new one`,
              { status: 400 }
            );
          }
          const object = namespace.get(namespace.idFromString(sessionId));
          const response = await object.onMCPMessage(request);

          // Convert headers to a plain object
          const headerObj: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headerObj[key] = value;
          });
          headerObj["Access-Control-Allow-Origin"] = corsOptions?.origin || "*";

          return new Response(response.body as unknown as BodyInit, {
            status: response.status,
            statusText: response.statusText,
            headers: headerObj,
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    };
  }
}
