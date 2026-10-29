import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { MCPClientManager } from "../../mcp/client";
import { MCPConnectionState } from "../../mcp/client/connection";
import {
  backdateMcpJobs,
  expireOAuthStates,
  mcpJobs,
  type McpJobRow
} from "../shared/mcp-time-travel";

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

  /**
   * Register an MCP server with the default transport and connect to it, as
   * a standalone manager does. One quick attempt per connect.
   */
  async addServer(
    id: string,
    url: string,
    callbackUrl: string
  ): Promise<{ state: string; authUrl?: string; clientId?: string }> {
    await this.lifecycle.start();
    await this.mcp.registerServer(id, {
      name: id,
      url,
      callbackUrl,
      transport: { type: "auto" },
      retry: { maxAttempts: 1 }
    });
    const result = await this.mcp.connectToServer(id);
    return result.state === "authenticating"
      ? {
          state: result.state,
          authUrl: result.authUrl,
          clientId: result.clientId
        }
      : { state: result.state };
  }

  /**
   * Connect a registered server again, as a standalone manager does on
   * request: connect, then discover.
   */
  async reconnect(id: string): Promise<void> {
    await this.lifecycle.start();
    const result = await this.mcp.connectToServer(id);
    if (result.state === "connected") await this.mcp.discoverIfConnected(id);
  }

  /**
   * Register a server as if a session with it had been saved, so the next
   * wake resumes that session instead of starting a new one.
   */
  async registerResumedServer(
    id: string,
    url: string,
    callbackUrl: string,
    sessionId: string
  ): Promise<void> {
    await this.lifecycle.start();
    await this.mcp.registerServer(id, {
      name: id,
      url,
      callbackUrl,
      transport: {
        type: "streamable-http",
        sessionId,
        protocolVersion: "2025-11-25"
      }
    });
  }

  /** Wait for connection work started by callbacks, restores and jobs. */
  async settle(): Promise<void> {
    await this.lifecycle.start();
    await this.mcp.waitForConnections();
  }

  /**
   * Reset the object the way the runtime does when it tears one down: memory
   * is gone, storage stays, and the next call starts a fresh instance.
   */
  restart(): void {
    this.ctx.abort("restarted by test");
  }

  mcpJobs(): McpJobRow[] {
    return mcpJobs(this.ctx.storage);
  }

  backdateMcpJobs(): void {
    backdateMcpJobs(this.ctx.storage);
  }

  expireOAuthStates(): Promise<void> {
    return expireOAuthStates(this.ctx.storage);
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
