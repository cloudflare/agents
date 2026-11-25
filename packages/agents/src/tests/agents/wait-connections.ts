import { Agent } from "../../index.ts";

/**
 * Test Agent that exposes waitForConnections() for E2E testing.
 * Simulates the full hibernation → restore → wait → getAITools flow.
 *
 * It connects for real: the tests fake the MCP servers with msw, so a
 * connection settles when the fake server answers, not after a time.
 */
export class TestWaitConnectionsAgent extends Agent {
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

  /** Wait for the lifecycle-started restores without triggering another one. */
  async waitAndReport(timeout?: number): Promise<{
    connectionIds: string[];
    connectionStates: Record<string, string>;
  }> {
    await this.mcp.waitForConnections(
      timeout != null ? { timeout } : undefined
    );

    return {
      connectionIds: Object.keys(this.mcp.mcpConnections),
      connectionStates: Object.fromEntries(
        Object.entries(this.mcp.mcpConnections).map(([id, connection]) => [
          id,
          connection.connectionState
        ])
      )
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

  /** Report lifecycle-restored connections without waiting for them to settle. */
  reportWithoutWait(): {
    connectionIds: string[];
    connectionStates: Record<string, string>;
  } {
    return {
      connectionIds: Object.keys(this.mcp.mcpConnections),
      connectionStates: Object.fromEntries(
        Object.entries(this.mcp.mcpConnections).map(([id, connection]) => [
          id,
          connection.connectionState
        ])
      )
    };
  }

  hasMcpConnection(serverId: string): boolean {
    return !!this.mcp.mcpConnections[serverId];
  }

  getConnectionState(serverId: string): string | null {
    return this.mcp.mcpConnections[serverId]?.connectionState ?? null;
  }
}
