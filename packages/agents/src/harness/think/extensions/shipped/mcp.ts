/**
 * The tools of the MCP servers an agent is connected to, as an extension on
 * ThinkHarness's core: what `MCPClientManager.getAITools()` returns, the
 * set Think merges into every turn.
 *
 * @internal Not exported from any entry point.
 */
import type { MCPClientManager } from "../../../../mcp/client/manager";
import type { ThinkExtension } from "../types";

/** @internal */
export type McpExtensionOptions = {
  /** The agent's MCP client. */
  readonly manager: () => MCPClientManager;
  /** Whether the tools are offered; read once per build. Default: yes. */
  readonly include?: () => boolean;
};

/** @internal */
export function mcpExtension(options: McpExtensionOptions): ThinkExtension {
  return (ctx) =>
    ctx.tools.transform((tools) => {
      if (options.include?.() === false) return;
      for (const [name, tool] of Object.entries(
        options.manager().getAITools()
      )) {
        tools.set(name, tool);
      }
    });
}

/**
 * Wait for the MCP servers' connections, `true` for ten seconds or for a
 * timeout, and set no tools. Loaded ahead of every other extension, as
 * Think waits at the top of a turn, so tools built from the MCP catalog
 * (the agent's own included) see servers that came up during the wait.
 *
 * @internal
 */
export function mcpConnectionsExtension(
  manager: () => MCPClientManager,
  waitForConnections: () => boolean | { readonly timeout: number }
): ThinkExtension {
  return (ctx) =>
    ctx.tools.transform(async () => {
      const wait = waitForConnections();
      if (!wait) return;
      await manager().waitForConnections({
        timeout: typeof wait === "object" ? wait.timeout : 10_000
      });
    });
}
