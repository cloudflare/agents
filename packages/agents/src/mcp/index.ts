/**
 * MCP compatibility entry point.
 *
 * Stateless servers should import the Worker wrapper from
 * `agents/mcp/server`. MCP clients should import from `agents/mcp/client`.
 * This barrel retains the SDK v1 `McpAgent`, `WorkerTransport`, legacy handler,
 * edge transports, and historical exports for existing applications.
 */
export * from "./legacy-agent";
