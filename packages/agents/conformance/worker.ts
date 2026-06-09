import {
  Agent,
  type AgentNamespace,
  getAgentByName,
  routeAgentRequest
} from "../src/index.ts";
import { MCPConnectionState } from "../src/mcp/client-connection.ts";
import { isUnauthorized, toErrorMessage } from "../src/mcp/errors.ts";
import {
  createMcpHandler,
  DurableObjectEventStore,
  McpAgent,
  type TransportState,
  WorkerTransport
} from "../src/mcp/index.ts";
import { createEverythingServer } from "./everything-server.ts";

/**
 * Conformance worker — hosts everything the MCP conformance suite needs from
 * this repo inside workerd, so the implementations are tested as they actually
 * run in production (Durable Object storage, real routes, real transports).
 *
 * Client under test (`conformance client`):
 *  - ConformanceHost: Agent + MCPClientManager. The conformance CLI spawns
 *    driver.mjs once per scenario; the driver POSTs `{ scenario, serverUrl }`
 *    to a fresh agent instance, which connects out to the conformance
 *    harness's test server. When the connection needs OAuth, the worker
 *    responds with the authorization URL; the driver plays the role of the
 *    user's browser (follows the redirect into this worker's real callback
 *    route) and then calls /run again to continue the scenario.
 *
 * Servers under test (`conformance server --url ...`):
 *  - /mcp-agent: McpAgent
 *  - /mcp-handler: createMcpHandler + WorkerTransport inside an Agent
 *  Both register the same "everything server" feature set (everything-server.ts).
 */

type Env = {
  ConformanceHost: DurableObjectNamespace;
  EverythingMcpAgent: DurableObjectNamespace;
  EverythingHandlerAgent: AgentNamespace<EverythingHandlerAgent>;
};

const SERVER_NAME = "conformance";

type RunRequest = { scenario: string; serverUrl: string; context?: string };

type RunResult =
  | { status: "done" }
  | { status: "auth"; authUrl: string }
  | { status: "error"; error: string };

export class ConformanceHost extends Agent<Env> {
  private _serverId: string | undefined;

  onStart() {
    // Respond to OAuth callbacks with an explicit status the driver can
    // assert on, instead of the default redirect-to-origin.
    this.mcp.configureOAuthCallback({
      customHandler: (result) =>
        Response.json(result, { status: result.authSuccess ? 200 : 400 })
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/run")) {
      const { scenario, serverUrl, context } =
        (await request.json()) as RunRequest;
      try {
        return Response.json(
          await this.runScenario(scenario, serverUrl, context)
        );
      } catch (error) {
        return Response.json({
          status: "error",
          error: toErrorMessage(error)
        } satisfies RunResult);
      }
    }
    if (request.method === "GET" && url.pathname.endsWith("/debug")) {
      return Response.json({ servers: this.mcp.listServers() });
    }
    return new Response("Not found", { status: 404 });
  }

  private async runScenario(
    scenario: string,
    serverUrl: string,
    context?: string
  ): Promise<RunResult> {
    try {
      if (!this._serverId) {
        const result = await this.addMcpServer(SERVER_NAME, serverUrl, {
          transport: { type: "streamable-http" }
        });
        this._serverId = result.id;
        if (result.state === MCPConnectionState.AUTHENTICATING) {
          return { status: "auth", authUrl: result.authUrl };
        }
      }

      await this.waitForReady(this._serverId);
      await this.runScenarioSteps(scenario, this._serverId);
      return { status: "done" };
    } catch (error) {
      // Authorization servers without dynamic client registration require
      // pre-registered credentials, which the conformance harness provides
      // via context. Seed them into the OAuth provider and retry once.
      const seeded = await this.seedPreRegisteredClient(error, context);
      if (seeded) {
        return this.runScenario(scenario, serverUrl, undefined);
      }

      // A 401 can surface from any phase: connect, discovery (servers that
      // allow unauthenticated initialize but protect tools/list), or a tool
      // call (scope step-up). In all cases the SDK has already run the OAuth
      // authorization request and handed the authorization URL to our
      // provider — surface it so the driver can authorize in its fake
      // browser and call /run again.
      const reauth = this.requestReauth(error);
      if (reauth) {
        return reauth;
      }
      throw error;
    }
  }

  /**
   * Seed pre-registered OAuth client credentials (auth/pre-registration
   * scenario). The provider is created during addMcpServer, so the first
   * connect attempt fails with "does not support dynamic client
   * registration"; seed the credentials it should have used and signal the
   * caller to retry.
   */
  private async seedPreRegisteredClient(
    error: unknown,
    context: string | undefined
  ): Promise<boolean> {
    if (
      !context ||
      !toErrorMessage(error).includes(
        "does not support dynamic client registration"
      )
    ) {
      return false;
    }

    const parsed = JSON.parse(context) as {
      name?: string;
      client_id?: string;
      client_secret?: string;
    };
    if (!parsed.client_id) {
      return false;
    }

    const serverId =
      this._serverId ??
      this.mcp.listServers().find((s) => s.name === SERVER_NAME)?.id;
    const conn = serverId ? this.mcp.mcpConnections[serverId] : undefined;
    const provider = conn?.options.transport.authProvider;
    if (!serverId || !conn || !provider) {
      return false;
    }
    this._serverId = serverId;

    provider.serverId = serverId;
    await provider.saveClientInformation?.({
      client_id: parsed.client_id,
      client_secret: parsed.client_secret,
      redirect_uris: [String(provider.redirectUrl)]
    });

    // Retry from a clean connect with the seeded credentials.
    conn.connectionState = MCPConnectionState.CONNECTING;
    await this.mcp.establishConnection(serverId).catch(() => {
      // 401 → AUTHENTICATING is surfaced by the retry in runScenario.
    });
    return true;
  }

  private requestReauth(error: unknown): RunResult | undefined {
    if (!isUnauthorized(error)) {
      return undefined;
    }

    // addMcpServer throws before returning an id when discovery fails, so
    // fall back to looking the server up by name.
    const serverId =
      this._serverId ??
      this.mcp.listServers().find((s) => s.name === SERVER_NAME)?.id;
    if (!serverId) {
      return undefined;
    }
    this._serverId = serverId;

    const conn = this.mcp.mcpConnections[serverId];
    const authUrl = conn?.options.transport.authProvider?.authUrl;
    if (!conn || !authUrl) {
      return undefined;
    }

    conn.connectionState = MCPConnectionState.AUTHENTICATING;
    return { status: "auth", authUrl };
  }

  /**
   * Wait for the connection to reach READY. After an OAuth callback the
   * connection is re-established in the background (establishConnection), so
   * the next /run call has to poll for the terminal state.
   */
  // Generous timeout: on cold CI runners, connection retries (exponential
  // backoff) plus the SDK's SSE retry interval can stack well past 25s.
  private async waitForReady(serverId: string, timeoutMs = 50_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const conn = this.mcp.mcpConnections[serverId];
      if (conn) {
        if (conn.connectionState === MCPConnectionState.READY) {
          return conn;
        }
        if (conn.connectionState === MCPConnectionState.AUTHENTICATING) {
          // Routed through requestReauth() by the caller's catch block.
          throw new Error("Unauthorized: connection requires authorization");
        }
        if (conn.connectionState === MCPConnectionState.FAILED) {
          throw new Error(
            `Connection failed: ${conn.connectionError ?? "unknown error"}`
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for connection to become ready`);
  }

  private async runScenarioSteps(
    scenario: string,
    serverId: string
  ): Promise<void> {
    switch (scenario) {
      case "initialize":
        // Connecting runs the full initialize handshake plus discovery
        // (tools/resources/prompts listing) — nothing further to do.
        return;
      case "tools_call":
        await this.callTool(serverId, "add_numbers", { a: 5, b: 3 });
        return;
      case "sse-retry":
        await this.callTool(serverId, "test_reconnection", {});
        return;
      case "elicitation-sep1034-client-defaults":
        await this.callTool(serverId, "test_client_elicitation_defaults", {});
        return;
      default:
        if (scenario.startsWith("auth/")) {
          await this.callTool(serverId, "test-tool", {});
          return;
        }
        throw new Error(`Unsupported scenario: ${scenario}`);
    }
  }

  private async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const result = await this.mcp.callTool({
      serverId,
      name,
      arguments: args
    });
    if (result.isError) {
      throw new Error(
        `Tool "${name}" returned an error: ${JSON.stringify(result.content)}`
      );
    }
  }
}

/**
 * Server conformance variant 1: McpAgent.
 */
export class EverythingMcpAgent extends McpAgent<Env> {
  server = createEverythingServer();

  async init() {}
}

const everythingMcpAgentHandler = EverythingMcpAgent.serve("/mcp-agent", {
  binding: "EverythingMcpAgent"
});

const TRANSPORT_STATE_KEY = "mcp_transport_state";

/**
 * Server conformance variant 2: createMcpHandler + WorkerTransport inside an
 * Agent (modeled on the mcp-elicitation example).
 */
export class EverythingHandlerAgent extends Agent<Env> {
  server = createEverythingServer({
    closeSSEStream: (requestId) => this.transport.closeSSEStream(requestId)
  });

  transport = new WorkerTransport({
    sessionIdGenerator: () => this.name,
    storage: {
      get: () => {
        return this.ctx.storage.kv.get<TransportState>(TRANSPORT_STATE_KEY);
      },
      set: (state: TransportState) => {
        this.ctx.storage.kv.put<TransportState>(TRANSPORT_STATE_KEY, state);
      }
    },
    // Persist SSE events so clients can reconnect with `Last-Event-ID` and
    // replay missed messages (SEP-1699 resumability).
    eventStore: new DurableObjectEventStore(this.ctx.storage)
  });

  async onMcpRequest(request: Request) {
    return createMcpHandler(this.server, {
      route: "/mcp-handler",
      transport: this.transport
    })(request, this.env, {} as ExecutionContext);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp-agent") {
      return everythingMcpAgentHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp-handler") {
      const sessionId =
        request.headers.get("mcp-session-id") ?? crypto.randomUUID();
      const agent = await getAgentByName(env.EverythingHandlerAgent, sessionId);
      return agent.onMcpRequest(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
