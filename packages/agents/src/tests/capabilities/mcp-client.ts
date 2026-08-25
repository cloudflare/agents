import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { MCPClientManager } from "../../mcp/client";
import { MCPConnectionState } from "../../mcp/client-connection";
import {
  ensureMcpServerTable,
  type MCPServerRow
} from "../../mcp/client-storage";
import type { MCPClientManagerOptions } from "../../mcp/client";
import { withCapabilityHarness } from "./harness";

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
}

/**
 * Real-Durable-Object harness for MCP client manager tests, built on the
 * generic capability harness: managers operate on real SQLite storage
 * through real Lifecycle services instead of hand-rolled storage mocks.
 * `createManager` may be called more than once to simulate a hibernation
 * wake-up — a fresh manager over the same persisted storage.
 */
export type McpHarness = {
  /** The harness object's real Durable Object storage. */
  readonly storage: DurableObjectStorage;
  /** Construct a manager bound to this object through a real Lifecycle. */
  readonly createManager: (
    options?: MCPClientManagerOptions
  ) => MCPClientManager;
  /**
   * Bind a pre-constructed manager — for example a test subclass — to this
   * object through a real Lifecycle and return it.
   */
  readonly installManager: <Manager extends MCPClientManager>(
    manager: Manager
  ) => Manager;
  /** Read the persisted MCP server rows, oldest first. */
  readonly serverRows: () => MCPServerRow[];
};

/** Run one test body against a fresh real-Durable-Object MCP harness. */
export async function withMcpHarness<T>(
  fn: (harness: McpHarness) => Promise<T> | T
): Promise<T> {
  return withCapabilityHarness(async ({ storage, install }) => {
    ensureMcpServerTable(storage);
    // Binding without starting matches production timing: services are
    // available from `use()`, while restoration stays an explicit call
    // (`restoreConnectionsFromStorage`) just as tests exercise it.
    const installManager = <Manager extends MCPClientManager>(
      manager: Manager
    ): Manager => install(manager).capability;
    return fn({
      storage,
      createManager: (options) =>
        installManager(new MCPClientManager("test-client", "1.0.0", options)),
      installManager,
      serverRows: () => [
        ...storage.sql.exec<MCPServerRow>(
          "SELECT * FROM cf_agents_mcp_servers ORDER BY rowid"
        )
      ]
    });
  });
}
