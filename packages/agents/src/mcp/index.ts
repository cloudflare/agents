import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Agent, getAgentByName } from "../index";
import type { MaybePromise, CORSOptions } from "./types";
import { handleCORS, isDurableObjectNamespace } from "./utils";
import { injectCfWorkerValidator } from "./cf-validator";
import { createMcpHandler } from "./handler";

interface McpAgentServeOptions {
  /**
   * The Durable Object binding name for the McpAgent.
   * @default "MCP_OBJECT"
   */
  binding?: string;
  /**
   * CORS options for the handler.
   */
  corsOptions?: CORSOptions;
  /**
   * Jurisdiction for DO placement.
   */
  jurisdiction?: DurableObjectJurisdiction;
}

export abstract class McpAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  /**
   * The MCP server instance. Create this in your class definition.
   *
   * ```ts
   * server = new McpServer({ name: "My Server", version: "1.0.0" });
   * ```
   */
  abstract server: MaybePromise<McpServer | Server>;

  /**
   * Props passed from the Worker to this DO instance.
   * Available after init() is called.
   */
  props?: Props;

  private _mcpTransport?: WebStandardStreamableHTTPServerTransport;
  private _mcpServerConnected = false;
  private _mcpSetupPromise?: Promise<void>;
  private _mcpHandler?: (request: Request) => Promise<Response>;

  /**
   * Override this method to register tools, resources, and prompts
   * on the MCP server.
   *
   * ```ts
   * async init() {
   *   this.server.registerTool("add", { ... }, async () => { ... });
   * }
   * ```
   */
  async init(): Promise<void> {}

  /**
   * Internal: wrap onStart to handle props, user init(), and MCP setup.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const _userOnStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      // Store props in DO storage so they survive hibernation
      if (props) {
        await this.ctx.storage.put("mcp:props", props);
      }
      this.props = (await this.ctx.storage.get<Props>("mcp:props")) ?? props;

      // Call the parent onStart (Agent lifecycle)
      await _userOnStart(props);

      // Call user's init() (where they register tools, resources, etc.)
      // Tools must be registered BEFORE connecting to the transport.
      await this.init();

      // Set up MCP transport and connect the server
      await this._setupMcp();
    };
  }

  /**
   * Internal: set up the MCP transport and connect the server.
   */
  private async _setupMcp() {
    if (this._mcpServerConnected) {
      return;
    }

    // Create a stateful transport. The DO IS the session, so we use
    // a fixed session ID derived from the DO name.
    const sessionId = this.name;

    this._mcpTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId
    });

    const server = await this.server;
    injectCfWorkerValidator(server);
    await server.connect(this._mcpTransport);
    this._mcpServerConnected = true;

    // Create the request handler using createMcpHandler in stateful mode
    const handler = createMcpHandler(() => server, {
      transport: this._mcpTransport,
      route: ""
    });
    this._mcpHandler = (request: Request) =>
      handler(request, {} as unknown, {} as ExecutionContext);

    // Intercept onmessage AFTER server.connect (which sets the handler)
    // to capture initialize params for state persistence
    const serverOnMessage = this._mcpTransport.onmessage;
    this._mcpTransport.onmessage = async (message, extra) => {
      // Store initialize request params for replay on DO wake
      if (isInitializeRequest(message)) {
        await this.ctx.storage.put("mcp:initializeRequest", message);
      }

      serverOnMessage?.call(this._mcpTransport, message, extra);
    };

    // Restore state if DO was previously initialized
    await this._restoreState();
  }

  /**
   * Restore MCP transport state after DO wake from hibernation.
   */
  private async _restoreState() {
    const initializeRequest = await this.ctx.storage.get<JSONRPCMessage>(
      "mcp:initializeRequest"
    );
    if (initializeRequest && this._mcpTransport) {
      // Replay the initialize request to restore server capabilities
      this._mcpTransport.onmessage?.(initializeRequest);
    }
  }

  /**
   * Handle an MCP HTTP request directly in the DO.
   *
   * The DO cannot hibernate while a request is being processed (the tool
   * callback's Promise is pending), so no explicit keep-alive alarm is
   * needed — even for elicitation which awaits a client response inside
   * the original tool call's request handler.
   */
  async onRequest(request: Request): Promise<Response> {
    if (!this._mcpHandler) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "MCP transport not initialized" },
          id: null
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return this._mcpHandler(request);
  }

  /**
   * Return a Worker-side handler that routes MCP requests to this DO class.
   *
   * ```ts
   * export default {
   *   fetch(request, env, ctx) {
   *     return MyMCP.serve("/mcp", { binding: "MyMCP" }).fetch(request, env, ctx);
   *   }
   * };
   * ```
   */
  static serve(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions,
      jurisdiction
    }: McpAgentServeOptions = {}
  ) {
    return {
      async fetch<Env>(
        this: void,
        request: Request,
        env: Env,
        ctx: ExecutionContext
      ): Promise<Response> {
        const url = new URL(request.url);

        // Check if this request matches our path
        if (!url.pathname.startsWith(path)) {
          return new Response("Not found", { status: 404 });
        }

        // Handle CORS preflight
        const corsResponse = handleCORS(request, corsOptions);
        if (corsResponse) {
          return corsResponse;
        }

        // Get the DO namespace binding
        const bindingValue = env[binding as keyof typeof env] as unknown;
        if (bindingValue == null || typeof bindingValue !== "object") {
          throw new Error(
            `Could not find McpAgent binding for ${binding}. Did you update your wrangler configuration?`
          );
        }
        if (!isDurableObjectNamespace(bindingValue)) {
          throw new Error(
            `Invalid McpAgent binding for ${binding}. Make sure it's a Durable Object binding.`
          );
        }

        const namespace =
          bindingValue as unknown as DurableObjectNamespace<McpAgent>;

        // Route to the correct DO based on session ID
        let sessionId = request.headers.get("mcp-session-id");

        if (!sessionId) {
          // No session ID — this should be an initialization request.
          // Create a new DO with a unique ID.
          sessionId = namespace.newUniqueId().toString();
        }

        // Get the DO stub and forward the request directly
        const agent = await getAgentByName(namespace, sessionId, {
          props: ctx.props as Record<string, unknown> | undefined,
          jurisdiction
        });

        // Forward the request to the DO's fetch handler.
        // CORS response headers are added by createMcpHandler inside the DO.
        return agent.fetch(request);
      }
    };
  }

}

// Re-exports
export {
  SSEEdgeClientTransport,
  StreamableHTTPEdgeClientTransport
} from "./client-transports";

export {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";

export type {
  MCPClientOAuthResult,
  MCPClientOAuthCallbackConfig,
  MCPServerOptions,
  MCPConnectionResult,
  MCPDiscoverResult
} from "./client";

export {
  createMcpHandler,
  experimental_createMcpHandler,
  type CreateMcpHandlerOptions
} from "./handler";

export { getMcpAuthContext, type McpAuthContext } from "./auth-context";

/**
 * @deprecated WorkerTransport has been removed. Use `WebStandardStreamableHTTPServerTransport`
 * from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` directly, or use
 * `createMcpHandler` / `McpAgent` which handle transport creation for you.
 */
export const WorkerTransport = WebStandardStreamableHTTPServerTransport;
