import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { MCPClientManager } from "../../mcp/client";
import { MCPConnectionState } from "../../mcp/client/connection";

/**
 * A plain Lifecycle Object with the MCP client manager installed, used to
 * prove the manager as a capability: persisted-connection restore across
 * real eviction, OAuth callback interception ahead of the host request
 * handler, and fresh OAuth flows — all through Lifecycle hooks on a
 * non-Agent host.
 */
export class PlainMcpClientObject extends DurableObject<Cloudflare.Env> {
  readonly mcp = new MCPClientManager("plain-lifecycle-object", "1.0.0");

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);

  onRequest(): Response {
    return Response.json({
      connectionIds: Object.keys(this.mcp.mcpConnections),
      states: Object.fromEntries(
        Object.entries(this.mcp.mcpConnections).map(([id, connection]) => [
          id,
          connection.connectionState
        ])
      ),
      storedServerCount: this.mcp.listServers().length
    });
  }

  async prepareRestorableServer(): Promise<void> {
    await this.lifecycle.start();
    await this.mcp.registerServer("server", {
      name: "Test server",
      url: "https://mcp.example.com",
      callbackUrl: "https://example.com/callback",
      transport: { type: "auto" }
    });
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_mcp_servers SET auth_url = ? WHERE id = ?",
      "https://auth.example.com/authorize",
      "server"
    );
  }

  async prepareOAuthCallback(): Promise<string> {
    await this.lifecycle.start();
    this.mcp.configureOAuthCallback({
      customHandler: (result) => Response.json(result)
    });
    await this.mcp.registerServer("callback-server", {
      name: "Test server",
      url: "https://mcp.example.com",
      callbackUrl: "https://example.com/callback",
      transport: { type: "auto" }
    });

    const connection = this.mcp.mcpConnections["callback-server"];
    const authProvider = connection.options.transport.authProvider;
    if (!authProvider?.state) {
      throw new Error("Expected a stateful default OAuth provider");
    }
    connection.connectionState = MCPConnectionState.AUTHENTICATING;
    return authProvider.state();
  }

  async startFreshOAuthFlow(): Promise<unknown> {
    await this.lifecycle.start();
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authorizationServerUrl = "https://auth.example.com";

    const oauthFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (request.url === serverUrl) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`
          }
        });
      }

      if (request.url === resourceMetadataUrl) {
        return Response.json({
          resource: serverUrl,
          authorization_servers: [authorizationServerUrl]
        });
      }

      if (
        url.origin === authorizationServerUrl &&
        url.pathname.includes(".well-known")
      ) {
        return Response.json({
          issuer: authorizationServerUrl,
          authorization_endpoint: `${authorizationServerUrl}/authorize`,
          token_endpoint: `${authorizationServerUrl}/token`,
          registration_endpoint: `${authorizationServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        });
      }

      if (
        url.origin === authorizationServerUrl &&
        url.pathname === "/register" &&
        request.method === "POST"
      ) {
        return Response.json({
          client_id: "test-client-id",
          redirect_uris: ["https://example.com/callback"]
        });
      }

      return new Response(`Unexpected OAuth test request: ${request.url}`, {
        status: 500
      });
    };

    await this.mcp.registerServer("fresh-oauth-server", {
      name: "Fresh OAuth server",
      url: serverUrl,
      callbackUrl: "https://example.com/callback",
      transport: { type: "streamable-http", fetch: oauthFetch }
    });

    return this.mcp.connectToServer("fresh-oauth-server");
  }

  /** Whether the flaky test server accepts connections. */
  #flakyServerUp = false;

  /**
   * A minimal MCP server reached through the transport's `fetch`, which
   * answers 503 until {@link allowFlakyServer} is called.
   */
  readonly #flakyFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!this.#flakyServerUp) {
      return new Response("unavailable", { status: 503 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json()) as { id?: number; method?: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const ok = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return ok({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "flaky", version: "1.0.0" }
        });
      case "tools/list":
        return ok({
          tools: [{ name: "echo", inputSchema: { type: "object" } }]
        });
      default:
        return ok({});
    }
  };

  /** Register a server that is down, and start connecting to it. */
  async prepareFlakyServer(): Promise<void> {
    await this.lifecycle.start();
    this.#flakyServerUp = false;
    await this.mcp.registerServer("flaky", {
      name: "Flaky server",
      url: "https://flaky.example.com/mcp",
      transport: { type: "streamable-http", fetch: this.#flakyFetch },
      retry: { maxAttempts: 1 }
    });
    await this.mcp.establishConnection("flaky");
  }

  /** Bring the flaky server up. */
  allowFlakyServer(): void {
    this.#flakyServerUp = true;
  }

  /** The MCP manager's queued jobs, oldest first. */
  mcpJobs(): Array<{ id: string; fn: string; time: number; payload: unknown }> {
    return this.ctx.storage.sql
      .exec<{ id: string; fn: string; time: number; payload: string | null }>(
        "SELECT id, fn, time, payload FROM cf_agents_jobs WHERE capability = 'mcp' ORDER BY time"
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        fn: row.fn,
        time: row.time,
        payload: row.payload ? JSON.parse(row.payload) : undefined
      }));
  }

  /** Make every queued MCP job due now. */
  backdateMcpJobs(): void {
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_jobs SET time = ? WHERE capability = 'mcp'",
      Date.now() - 1
    );
  }

  /** Forget every OAuth state nonce, as if each authorization link expired. */
  async expireOAuthStates(): Promise<void> {
    const keys = [
      ...(await this.ctx.storage.list({ prefix: "/" })).keys()
    ].filter((key) => key.includes("/state/"));
    if (keys.length > 0) await this.ctx.storage.delete(keys);
  }

  /** One connection's state and error. */
  connectionStatus(
    id: string
  ): { state: string; error: string | null } | undefined {
    const connection = this.mcp.mcpConnections[id];
    return connection
      ? { state: connection.connectionState, error: connection.connectionError }
      : undefined;
  }
}
