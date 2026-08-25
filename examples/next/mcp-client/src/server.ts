import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { MCPClientManager } from "agents/mcp/client";
import {
  configureOAuthPopup,
  getMcpCatalog,
  handleDemoRequest
} from "./demo-api";
import type { McpCatalog } from "./demo-api";

/** Plain Durable Object composed with the reusable MCP client capability. */
export class McpClientObject extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("mcp-client-object", "1.0.0", {
    storage: this.ctx.storage
  });

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);

  onStart(): void {
    configureOAuthPopup(this.mcp);
  }

  onRequest(request: Request): Promise<Response> {
    return handleDemoRequest(this.mcp, request);
  }

  /** Native RPC bypasses fetch, so start the lifecycle explicitly. */
  async getCatalog(): Promise<McpCatalog> {
    await this.lifecycle.start();
    return getMcpCatalog(this.mcp);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
