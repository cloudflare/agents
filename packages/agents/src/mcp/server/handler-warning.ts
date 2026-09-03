let didWarnAboutLegacyCreateMcpHandlerOverload = false;

export function warnLegacyCreateMcpHandlerOverload(): void {
  if (didWarnAboutLegacyCreateMcpHandlerOverload) return;
  didWarnAboutLegacyCreateMcpHandlerOverload = true;
  console.warn(
    "[agents/mcp] Passing an MCP SDK v1 server to createMcpHandler is " +
      "deprecated and will be removed in the next major version. Pass an " +
      "@modelcontextprotocol/server factory to createMcpHandler. To " +
      "temporarily retain sessionful SDK v1 behavior while migrating, use " +
      "createLegacyMcpHandler."
  );
}
