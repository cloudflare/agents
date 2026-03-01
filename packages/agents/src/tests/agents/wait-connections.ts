import { Agent } from "../../index.ts";
import type { AgentContext } from "../../index.ts";
import { MCPConnectionState } from "../../mcp/client-connection.ts";

/**
 * Test Agent that exposes waitForConnections() for E2E testing.
 * Simulates the full hibernation → restore → wait → getAITools flow.
 *
 * connectToServer is mocked in the constructor so it's in place before
 * the Agent's onStart triggers restoreConnectionsFromStorage. The mock
 * fails with a small delay instead of making real network requests,
 * avoiding DNS "nodename nor servname" spam from fake server URLs.
 */
export class TestWaitConnectionsAgent extends Agent<Record<string, unknown>> {
  constructor(ctx: AgentContext, env: Record<string, unknown>) {
    super(ctx, env);
    // Patch immediately — before onStart calls restoreConnectionsFromStorage
    const mcp = this.mcp;
    mcp.connectToServer = async (id: string) => {
      // Small delay so background _restoreServer tasks don't resolve
      // synchronously, preserving the "connecting" initial state for
      // race-condition tests that check state without waiting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const conn = mcp.mcpConnections[id];
      if (conn) {
        conn.connectionState = MCPConnectionState.FAILED;
      }
      return { state: MCPConnectionState.FAILED, error: "test: mock server" };
    };
  }

  async onRequest(_request: Request): Promise<Response> {
    return new Response("TestWaitConnectionsAgent");
  }

  /**
   * Insert an MCP server row into SQLite (simulates pre-hibernation state).
   */
  insertMcpServer(
    serverId: string,
    name: string,
    serverUrl: string,
    callbackUrl: string,
    authUrl: string | null
  ): void {
    this.sql`
      INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (
        ${serverId},
        ${name},
        ${serverUrl},
        ${null},
        ${authUrl},
        ${callbackUrl},
        ${null}
      )
    `;
  }

  /**
   * Reset the restored flag so restoreConnectionsFromStorage can run again.
   */
  resetRestoredFlag(): void {
    // @ts-expect-error - accessing private property for testing
    this.mcp._isRestored = false;
    // Clear existing connections
    for (const id of Object.keys(this.mcp.mcpConnections)) {
      delete this.mcp.mcpConnections[id];
    }
  }

  /**
   * Trigger restore and then immediately wait for all connections to settle.
   * Returns info about the resulting connection states.
   */
  async restoreAndWait(timeout?: number): Promise<{
    connectionIds: string[];
    connectionStates: Record<string, string>;
  }> {
    await this.mcp.restoreConnectionsFromStorage(this.name);
    await this.mcp.waitForConnections(
      timeout != null ? { timeout } : undefined
    );

    const connectionStates: Record<string, string> = {};
    for (const [id, conn] of Object.entries(this.mcp.mcpConnections)) {
      connectionStates[id] = conn.connectionState;
    }

    return {
      connectionIds: Object.keys(this.mcp.mcpConnections),
      connectionStates
    };
  }

  /**
   * Trigger restore WITHOUT waiting, then immediately check states.
   * This simulates the race condition (old behavior).
   */
  async restoreWithoutWait(): Promise<{
    connectionIds: string[];
    connectionStates: Record<string, string>;
  }> {
    await this.mcp.restoreConnectionsFromStorage(this.name);
    // No waitForConnections — check states immediately

    const connectionStates: Record<string, string> = {};
    for (const [id, conn] of Object.entries(this.mcp.mcpConnections)) {
      connectionStates[id] = conn.connectionState;
    }

    return {
      connectionIds: Object.keys(this.mcp.mcpConnections),
      connectionStates
    };
  }

  /**
   * Check if waitForConnections resolves when there are no pending connections.
   */
  async waitWithNoPending(): Promise<boolean> {
    const start = Date.now();
    await this.mcp.waitForConnections();
    const elapsed = Date.now() - start;
    return elapsed < 100; // Should be near-instant
  }

  /**
   * Simulate a full hibernation round-trip:
   *   onStart() (triggers restoreConnectionsFromStorage internally)
   *   → waitForConnections()
   *   → check connection states
   *
   * This tests the real lifecycle path, not the decomposed methods.
   */
  async hibernationRoundTrip(timeout?: number): Promise<{
    connectionIds: string[];
    connectionStates: Record<string, string>;
  }> {
    // onStart() calls restoreConnectionsFromStorage which fires
    // background connections via _trackConnection
    await this.onStart();

    // This is what a consumer would call in onMessage / onChatMessage
    await this.mcp.waitForConnections(
      timeout != null ? { timeout } : undefined
    );

    const connectionStates: Record<string, string> = {};
    for (const [id, conn] of Object.entries(this.mcp.mcpConnections)) {
      connectionStates[id] = conn.connectionState;
    }

    return {
      connectionIds: Object.keys(this.mcp.mcpConnections),
      connectionStates
    };
  }

  /**
   * Simulate hibernation round-trip WITHOUT waiting — demonstrates the race.
   */
  async hibernationRoundTripNoWait(): Promise<{
    connectionIds: string[];
    connectionStates: Record<string, string>;
  }> {
    await this.onStart();

    // Check states immediately — no waitForConnections
    const connectionStates: Record<string, string> = {};
    for (const [id, conn] of Object.entries(this.mcp.mcpConnections)) {
      connectionStates[id] = conn.connectionState;
    }

    return {
      connectionIds: Object.keys(this.mcp.mcpConnections),
      connectionStates
    };
  }

  hasMcpConnection(serverId: string): boolean {
    return !!this.mcp.mcpConnections[serverId];
  }

  getConnectionState(serverId: string): string | null {
    return this.mcp.mcpConnections[serverId]?.connectionState ?? null;
  }
}
