import { Agent, callable, routeAgentRequest } from "agents";
import {
  MCPAuthorizationRequiredError,
  type ElicitRequest,
  type ElicitResult
} from "agents/mcp/client";

/**
 * An elicitation forwarded to the browser, awaiting a human response.
 * Shape of the `mcp-elicitation` broadcast message.
 */
export type PendingElicitation = {
  type: "mcp-elicitation";
  id: string;
  serverId: string;
  params: ElicitRequest["params"];
};

const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

export class MyAgent extends Agent {
  /**
   * Elicitations waiting on a human response, keyed by elicitation id.
   * In-memory only: a pending elicitation does not survive hibernation,
   * which is fine — the tool call awaiting it is a live request and would
   * not survive hibernation either.
   */
  private pendingElicitations = new Map<
    string,
    (result: ElicitResult) => void
  >();

  onStart() {
    this.mcp.configureElicitationHandlers({
      form: (request, serverId) =>
        this.forwardElicitationToBrowser(request, serverId),
      url: (request, serverId) =>
        this.forwardElicitationToBrowser(request, serverId)
    });

    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        const error = result.authError || "Unknown error";
        return new Response(`Authentication Failed: ${error}`, {
          headers: { "content-type": "text/plain" },
          status: 400
        });
      }
    });
  }

  /**
   * Forwards a connected MCP server's `elicitation/create` request to
   * browser clients and waits for one of them to answer via
   * `respondToElicitation`.
   */
  private async forwardElicitationToBrowser(
    request: ElicitRequest,
    serverId: string
  ): Promise<ElicitResult> {
    const id = crypto.randomUUID();

    const result = new Promise<ElicitResult>((resolve) => {
      this.pendingElicitations.set(id, resolve);
      // Don't hold the tool call open forever if nobody answers.
      setTimeout(() => {
        if (this.pendingElicitations.delete(id)) {
          resolve({ action: "cancel", content: {} });
        }
      }, ELICITATION_TIMEOUT_MS);
    });

    this.broadcast(
      JSON.stringify({
        type: "mcp-elicitation",
        id,
        serverId,
        params: request.params
      } satisfies PendingElicitation)
    );

    return result;
  }

  /** Called by the browser with the human's answer to an elicitation. */
  @callable()
  respondToElicitation(id: string, result: ElicitResult) {
    const resolve = this.pendingElicitations.get(id);
    if (resolve) {
      this.pendingElicitations.delete(id);
      resolve(result);
    }
  }

  /**
   * Add a server. Safe to call again for the same server: it reports the
   * server's current state and never reconnects or replaces its link.
   * The browser sees the state, the authorization link and any error
   * through the `cf_agent_mcp_servers` broadcast.
   */
  @callable()
  async addServer(name: string, url: string) {
    await this.addMcpServer(name, url);
  }

  /**
   * The "Reconnect" button: try a failed server again. It forgets why the
   * server stopped (reconnects gave up, authorization was refused or
   * expired) and connects now, showing a new link if it needs one.
   */
  @callable()
  async reconnectServer(serverId: string) {
    return await this.reconnectMcpServer(serverId);
  }

  @callable()
  async disconnectServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  /**
   * Run a tool. When the server needs the user to authorize again (a scope
   * step-up, or a token that can no longer be refreshed), hand the link to
   * the browser instead of failing; the server shows it too.
   */
  @callable()
  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ) {
    try {
      return await this.mcp.callTool({ serverId, name, arguments: args });
    } catch (error) {
      if (error instanceof MCPAuthorizationRequiredError) {
        return { authorizationRequired: true, authUrl: error.authUrl };
      }
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
