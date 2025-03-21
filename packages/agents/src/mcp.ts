import { DurableObject } from "cloudflare:workers";
import { Agent } from "./";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEEdgeTransport } from "./lib/sseEdge.ts";
import type { Connection } from "partyserver";

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends DurableObject {
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
  private transport!: SSEEdgeTransport;
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
    this.transport = new SSEEdgeTransport(
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
      corsOptions?: Parameters<typeof cors>[0];
    } = {}
  ) {
    const router = new Hono<{
      Bindings: Record<string, DurableObjectNamespace<McpAgent>>;
    }>();

    router.get(path, cors(corsOptions), async (c) => {
      const namespace = c.env[binding];
      const object = namespace.get(namespace.newUniqueId());
      // @ts-ignore
      object._init(c.executionCtx.props);
      return (await object.onSSE(path)) as unknown as Response;
    });

    router.post(`${path}/message`, cors(corsOptions), async (c) => {
      const namespace = c.env[binding];
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return new Response(
          `Missing sessionId. Expected POST to ${path} to initiate new one`,
          { status: 400 }
        );
      }
      const object = namespace.get(namespace.idFromString(sessionId));
      return (await object.onMCPMessage(c.req.raw)) as unknown as Response;
    });

    return router;
  }
}
