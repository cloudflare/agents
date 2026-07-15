// Vendored from packages/agents/src/mcp/client-storage.ts @ 762998da, ISSUE-003.
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
