let didWarnAboutLegacyCreateMcpHandlerOverload = false;

export function warnLegacyCreateMcpHandlerOverload(): void {
  if (didWarnAboutLegacyCreateMcpHandlerOverload) return;
  didWarnAboutLegacyCreateMcpHandlerOverload = true;
  console.warn(
    "[agents/mcp] Passing an MCP SDK v1 server to createMcpHandler is " +
      "deprecated and will be removed in the next major version. Use " +
      "createLegacyMcpHandler for an explicit 2025-era WorkerTransport " +
      "handler, or pass an @modelcontextprotocol/server factory to " +
      "createMcpHandler for current protocol support."
  );
}
