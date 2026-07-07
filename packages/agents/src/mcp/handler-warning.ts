let didWarnAboutLegacyHandlerCompatibility = false;

export function warnLegacyHandlerCompatibility(): void {
  if (didWarnAboutLegacyHandlerCompatibility) return;
  didWarnAboutLegacyHandlerCompatibility = true;
  console.warn(
    "[agents/mcp] This server is using the legacy MCP SDK v1 handler and " +
      "WorkerTransport compatibility stack. It will not receive new MCP " +
      "protocol features and will be removed in the next major version. " +
      'Upgrade createMcpHandler from "agents/mcp" and import McpServer or ' +
      'Server from "@modelcontextprotocol/server".'
  );
}
