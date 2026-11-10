import { Agent } from "../../index.ts";
import { MCPAuthorizationRequiredError } from "../../mcp/client/errors";
import {
  ageAuthorizationRounds,
  expireOAuthStates
} from "../shared/mcp-time-travel";

/** Where the OAuth callback sends the browser, by outcome. */
export const OAUTH_SUCCESS_PATH = "/oauth/success";
export const OAUTH_ERROR_PATH = "/oauth/error";

/** What `addMcpServer` produced, in a shape that crosses RPC. */
export type AddServerOutcome =
  | { id: string; state: "ready" }
  | { id: string; state: "authenticating"; authUrl: string }
  | { state: "error"; message: string };

/** What an MCP request produced, in a shape that crosses RPC. */
export type RequestOutcome =
  | { ok: true; text: string }
  | {
      ok: false;
      name: string;
      message: string;
      authorizationRequired: boolean;
      authUrl?: string;
    };

/** A server as `getMcpServers()` reports it to the UI. */
export type ServerView = {
  state: string;
  auth_url: string | null;
  error: string | null;
};

function failure(error: unknown): RequestOutcome {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    ok: false,
    name: err.name,
    message: err.message,
    authorizationRequired: error instanceof MCPAuthorizationRequiredError,
    authUrl:
      error instanceof MCPAuthorizationRequiredError ? error.authUrl : undefined
  };
}

/** The first text in an MCP result, whatever its shape. */
function firstText(result: unknown): string {
  const record = result as {
    content?: Array<{ text?: string }>;
    contents?: Array<{ text?: string }>;
    messages?: Array<{ content?: { text?: string } }>;
  };
  return (
    record.content?.[0]?.text ??
    record.contents?.[0]?.text ??
    record.messages?.[0]?.content?.text ??
    ""
  );
}

/**
 * An Agent that uses MCP servers the way an application does: `addMcpServer`,
 * `this.mcp` requests, AI SDK tools and `getMcpServers`. Its OAuth callbacks
 * arrive through the worker's `routeAgentRequest`. MCP integration tests drive
 * it over RPC; methods return failures as values, because an Agent method
 * that rejects over RPC also surfaces as an unhandled rejection in the
 * Workers test pool.
 */
export class McpIntegrationAgent extends Agent {
  /** Every state each server was broadcast in since this instance started. */
  readonly #history = new Map<string, ServerView[]>();

  async onStart(): Promise<void> {
    this.mcp.configureOAuthCallback({
      successRedirect: OAUTH_SUCCESS_PATH,
      errorRedirect: OAUTH_ERROR_PATH
    });
    this.mcp.onServerStateChanged(() => {
      for (const id of this.serverIds()) {
        const view = this.server(id);
        if (!view) continue;
        const seen = this.#history.get(id) ?? [];
        seen.push(view);
        this.#history.set(id, seen);
      }
    });
  }

  /** The OAuth storage keys the default provider holds for a server. */
  async oauthKeys(serverId: string): Promise<string[]> {
    const keys = await this.ctx.storage.list({
      prefix: `/${this.name}/${serverId}/`
    });
    return [...keys.keys()];
  }

  /** Every state a server was broadcast in, as a UI listening saw it. */
  serverHistory(serverId: string): ServerView[] {
    return this.#history.get(serverId) ?? [];
  }

  /** Add an MCP server with a single quick attempt per connect. */
  async connectServer(
    url: string,
    options: {
      /** Without one, the agent has no way to ask the user to authorize. */
      callbackHost?: string;
      id?: string;
      name?: string;
      transport?: "auto" | "streamable-http" | "sse";
      headers?: Record<string, string>;
      /** Quick connect attempts; one by default. */
      maxAttempts?: number;
    }
  ): Promise<AddServerOutcome> {
    try {
      const result = await this.addMcpServer(options.name ?? "files", url, {
        callbackHost: options.callbackHost,
        id: options.id,
        retry: { maxAttempts: options.maxAttempts ?? 1 },
        transport: {
          type: options.transport ?? "auto",
          headers: options.headers
        }
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

  /** `reconnectMcpServer`, as a "Reconnect" button calls it. */
  async reconnect(serverId: string): Promise<AddServerOutcome> {
    try {
      const result = await this.reconnectMcpServer(serverId);
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

  /** `MCPClientManager.connectToServer`, the manager's own connect. */
  async connectNow(
    serverId: string
  ): Promise<{ state: string; error?: string }> {
    try {
      const result = await this.mcp.connectToServer(serverId);
      return result.state === "failed"
        ? { state: result.state, error: result.error }
        : { state: result.state };
    } catch (error) {
      return {
        state: "rejected",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async callServerTool(
    serverId: string,
    name: string
  ): Promise<RequestOutcome> {
    try {
      const result = await this.mcp.callTool({ serverId, name, arguments: {} });
      return { ok: true, text: firstText(result) };
    } catch (error) {
      return failure(error);
    }
  }

  async readServerResource(
    serverId: string,
    uri: string
  ): Promise<RequestOutcome> {
    try {
      return {
        ok: true,
        text: firstText(await this.mcp.readResource({ serverId, uri }, {}))
      };
    } catch (error) {
      return failure(error);
    }
  }

  async getServerPrompt(
    serverId: string,
    name: string
  ): Promise<RequestOutcome> {
    try {
      return {
        ok: true,
        text: firstText(await this.mcp.getPrompt({ serverId, name }, {}))
      };
    } catch (error) {
      return failure(error);
    }
  }

  /** Run a server's tool the way the AI SDK does, through `getAITools()`. */
  async executeAITool(serverId: string, name: string): Promise<RequestOutcome> {
    const key = Object.keys(this.mcp.getAITools()).find(
      (candidate) =>
        candidate.endsWith(`_${name}`) &&
        candidate.includes(serverId.replace(/-/g, ""))
    );
    const tool = key ? this.mcp.getAITools()[key] : undefined;
    if (!tool?.execute) {
      return failure(new Error(`No AI tool ${name} for ${serverId}`));
    }
    try {
      const result = await tool.execute(
        {},
        { toolCallId: crypto.randomUUID(), messages: [] }
      );
      return { ok: true, text: firstText(result) };
    } catch (error) {
      return failure(error);
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

  /** `MCPClientManager.closeConnection`: the server stays stored. */
  closeNow(serverId: string): Promise<void> {
    return this.mcp.closeConnection(serverId);
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

  ageAuthorizationRounds(serverId: string, ms: number): void {
    ageAuthorizationRounds(this.ctx.storage, serverId, ms);
  }

  expireOAuthStates(): Promise<void> {
    return expireOAuthStates(this.ctx.storage);
  }
}
