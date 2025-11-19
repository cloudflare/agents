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
 * KV storage interface for OAuth-related data
 * Used by OAuth providers to store tokens, client info, etc.
 */
export interface OAuthClientStorage {
  /**
   * Get a value from key-value storage (for OAuth data like tokens, client info, etc.)
   */
  get<T>(key: string): Promise<T | undefined> | undefined;

  /**
   * Put a value into key-value storage (for OAuth data like tokens, client info, etc.)
   */
  put(key: string, value: unknown): Promise<void> | void;
}

/**
 * Storage interface for MCP client manager
 * Abstracts storage operations to decouple from specific storage implementations
 */
export interface MCPClientStorage extends OAuthClientStorage {
  /**
   * Save or update an MCP server configuration
   */
  saveServer(server: MCPServerRow): Promise<void>;

  /**
   * Remove an MCP server from storage
   */
  removeServer(serverId: string): Promise<void>;

  /**
   * List all MCP servers from storage
   */
  listServers(): Promise<MCPServerRow[]>;

  /**
   * Get an MCP server by its callback URL
   * Used during OAuth callback to identify which server is being authenticated
   */
  getServerByCallbackUrl(callbackUrl: string): Promise<MCPServerRow | null>;

  /**
   * Clear auth_url after successful OAuth authentication
   * This prevents the agent from continuously asking for OAuth on reconnect
   * when stored tokens are still valid.
   */
  clearAuthUrl(serverId: string): Promise<void>;
}

/**
 * SQL-based storage adapter that wraps SQL operations
 * Used by Agent class to provide SQL access to MCPClientManager
 */
export class AgentMCPClientStorage implements MCPClientStorage {
  constructor(
    private sql: <T extends Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) => T[],
    private kv: SyncKvStorage
  ) {}

  async saveServer(server: MCPServerRow) {
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

  async removeServer(serverId: string) {
    this.sql`
      DELETE FROM cf_agents_mcp_servers WHERE id = ${serverId}
    `;
  }

  async listServers() {
    const servers = this.sql<MCPServerRow>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
      FROM cf_agents_mcp_servers
    `;
    return servers;
  }

  async getServerByCallbackUrl(callbackUrl: string) {
    const results = this.sql<MCPServerRow>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
      FROM cf_agents_mcp_servers
      WHERE callback_url = ${callbackUrl}
      LIMIT 1
    `;
    return results.length > 0 ? results[0] : null;
  }

  async clearAuthUrl(serverId: string) {
    this.sql`
      UPDATE cf_agents_mcp_servers
      SET auth_url = NULL
      WHERE id = ${serverId}
    `;
  }

  async get<T>(key: string) {
    return this.kv.get<T>(key);
  }

  async put(key: string, value: unknown) {
    return this.kv.put(key, value);
  }
}
