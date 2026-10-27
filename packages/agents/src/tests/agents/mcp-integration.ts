import { Agent } from "../../index.ts";
import { MCPAuthorizationRequiredError } from "../../mcp/client/errors";
import {
  ageReconnectFailures,
  backdateMcpJobs,
  expireOAuthStates,
  mcpJobs,
  type McpJobRow
} from "../shared/mcp-time-travel";

/** What `addMcpServer` produced, in a shape that crosses RPC. */
export type AddServerOutcome =
  | { id: string; state: "ready" }
  | { id: string; state: "authenticating"; authUrl: string }
  | { state: "error"; message: string };

/** A server as `getMcpServers()` reports it to the UI. */
export type ServerView = {
  state: string;
  auth_url: string | null;
  error: string | null;
};

/** What `callTool` produced, in a shape that crosses RPC. */
export type ToolCallOutcome =
  | { ok: true; text: string }
  | {
      ok: false;
      name: string;
      message: string;
      authorizationRequired: boolean;
      authUrl?: string;
    };

/**
 * An Agent that uses MCP servers the way an application does: `addMcpServer`,
 * `this.mcp.callTool` and `getMcpServers`. Its OAuth callbacks arrive through
 * the worker's `routeAgentRequest`. MCP integration tests drive it over RPC.
 */
export class McpIntegrationAgent extends Agent {
  /**
   * Add an MCP server with a single quick attempt per connect. A failure is
   * returned rather than thrown: an Agent method that rejects over RPC also
   * surfaces as an unhandled rejection in the Workers test pool.
   */
  async connectServer(
    url: string,
    options: { callbackHost: string; id?: string; name?: string }
  ): Promise<AddServerOutcome> {
    try {
      const result = await this.addMcpServer(options.name ?? "files", url, {
        callbackHost: options.callbackHost,
        id: options.id,
        retry: { maxAttempts: 1 }
      });
      return result.state === "authenticating"
        ? { id: result.id, state: "authenticating", authUrl: result.authUrl }
        : { id: result.id, state: "ready" };
    } catch (error) {
      return {
        state: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async callServerTool(
    serverId: string,
    name: string
  ): Promise<ToolCallOutcome> {
    try {
      const result = await this.mcp.callTool({
        serverId,
        name,
        arguments: {}
      });
      const content = (result as { content?: Array<{ text?: string }> })
        .content;
      return { ok: true, text: content?.[0]?.text ?? "" };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        ok: false,
        name: err.name,
        message: err.message,
        authorizationRequired: error instanceof MCPAuthorizationRequiredError,
        authUrl:
          error instanceof MCPAuthorizationRequiredError
            ? error.authUrl
            : undefined
      };
    }
  }

  /** The server as the UI sees it. */
  server(serverId: string): ServerView | undefined {
    const server = this.getMcpServers().servers[serverId];
    return server
      ? { state: server.state, auth_url: server.auth_url, error: server.error }
      : undefined;
  }

  serverIds(): string[] {
    return Object.keys(this.getMcpServers().servers);
  }

  toolNames(): string[] {
    return this.mcp.listTools().map((tool) => tool.name);
  }

  /** Wait for connection work started by callbacks and restores. */
  settle(): Promise<void> {
    return this.mcp.waitForConnections();
  }

  remove(serverId: string): Promise<void> {
    return this.removeMcpServer(serverId);
  }

  /**
   * Reset the object the way the runtime does when it tears one down: memory
   * is gone, storage stays, and the next call starts a fresh instance.
   */
  restart(): void {
    this.ctx.abort("restarted by test");
  }

  mcpJobs(): McpJobRow[] {
    return mcpJobs(this.ctx.storage);
  }

  backdateMcpJobs(): void {
    backdateMcpJobs(this.ctx.storage);
  }

  ageReconnectFailures(serverId: string, ms: number): void {
    ageReconnectFailures(this.ctx.storage, serverId, ms);
  }

  expireOAuthStates(): Promise<void> {
    return expireOAuthStates(this.ctx.storage);
  }
}
