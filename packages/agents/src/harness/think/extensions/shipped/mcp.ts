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
  /**
   * Wait for the servers' connections before the tools are read: `true`
   * for ten seconds, or a timeout. Read once per build. Default: no wait.
   */
  readonly waitForConnections?: () => boolean | { readonly timeout: number };
};

/** @internal */
export function mcpExtension(options: McpExtensionOptions): ThinkExtension {
  return (ctx) =>
    ctx.tools.transform(async (tools) => {
      const wait = options.waitForConnections?.() ?? false;
      const manager = options.manager();
      if (wait) {
        await manager.waitForConnections({
          timeout: typeof wait === "object" ? wait.timeout : 10_000
        });
      }
      if (options.include?.() === false) return;
      for (const [name, tool] of Object.entries(manager.getAITools())) {
        tools.set(name, tool);
      }
    });
}
