import { Agent, callable, routeAgentRequest } from "agents";
import type { ElicitRequest, ElicitResult } from "agents/mcp";

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

  @callable()
  async addServer(name: string, url: string) {
    await this.addMcpServer(name, url);
  }

  @callable()
  async disconnectServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ) {
    return await this.mcp.callTool({ serverId, name, arguments: args });
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
