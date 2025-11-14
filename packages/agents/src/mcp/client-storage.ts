/**
 * Represents a row in the cf_agents_mcp_servers table
 */
export type MCPServerRow = {
  id: string;
  name: string;
  server_url: string;
  client_id: string | null;
  auth_url: string | null;
  callback_url: string;
  server_options: string | null;
};

/**
 * Storage adapter interface for MCP client manager
 * Abstracts SQL operations to decouple from specific storage implementations
 */
export interface MCPStorageAdapter {
  /**
   * Create the cf_agents_mcp_servers table if it doesn't exist
   */
  create(): void | Promise<void>;

  /**
   * Drop the cf_agents_mcp_servers table
   */
  destroy(): void | Promise<void>;

  /**
   * Save or update an MCP server configuration
   */
  saveServer(server: MCPServerRow): void | Promise<void>;

  /**
   * Remove an MCP server from storage
   */
  removeServer(serverId: string): void | Promise<void>;

  /**
   * List all MCP servers from storage
   */
  listServers(): MCPServerRow[] | Promise<MCPServerRow[]>;

  /**
   * Get an MCP server by its callback URL
   * Used during OAuth callback to identify which server is being authenticated
   */
  getServerByCallbackUrl(
    callbackUrl: string
  ): MCPServerRow | null | Promise<MCPServerRow | null>;

  /**
   * Clear both auth_url and callback_url after successful OAuth authentication
   * This prevents the agent from continuously asking for OAuth on reconnect
   * and prevents malicious second callbacks from being processed
   */
  clearOAuthCredentials(serverId: string): void | Promise<void>;
}

/**
 * SQL-based storage adapter that wraps SQL operations
 * Used by Agent class to provide SQL access to MCPClientManager
 */
export class AgentMCPStorageAdapter implements MCPStorageAdapter {
  constructor(
    private sql: <T extends Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) => T[]
  ) {}

  create(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;
  }

  destroy(): void {
    this.sql`DROP TABLE IF EXISTS cf_agents_mcp_servers`;
  }

  saveServer(server: MCPServerRow): void {
    this.sql`
      INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id,
        name,
        server_url,
        client_id,
        auth_url,
        callback_url,
        server_options
      )
      VALUES (
        ${server.id},
        ${server.name},
        ${server.server_url},
        ${server.client_id ?? null},
        ${server.auth_url ?? null},
        ${server.callback_url},
        ${server.server_options ?? null}
      )
    `;
  }

  removeServer(serverId: string): void {
    this.sql`
      DELETE FROM cf_agents_mcp_servers WHERE id = ${serverId}
    `;
  }

  listServers(): MCPServerRow[] {
    const servers = this.sql<MCPServerRow>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
      FROM cf_agents_mcp_servers
    `;
    return servers;
  }

  getServerByCallbackUrl(callbackUrl: string): MCPServerRow | null {
    const results = this.sql<MCPServerRow>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
      FROM cf_agents_mcp_servers
      WHERE callback_url = ${callbackUrl}
      LIMIT 1
    `;
    return results.length > 0 ? results[0] : null;
  }

  clearOAuthCredentials(serverId: string): void {
    this.sql`
      UPDATE cf_agents_mcp_servers
      SET callback_url = '', auth_url = NULL
      WHERE id = ${serverId}
    `;
  }
}
