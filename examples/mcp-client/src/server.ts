import { Agent, type AgentNamespace, routeAgentRequest } from "agents";
import type { MCPClientOAuthResult } from "agents/mcp";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
  HOST?: string; // Optional - will be derived from request if not provided
};

export class MyAgent extends Agent<Env, never> {
  onStart() {
    // Optionally configure OAuth callback. Here we use popup-closing behavior since we're opening a window on the client
    this.mcp.configureOAuthCallback({
      customHandler: (result: MCPClientOAuthResult) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        } else {
          return new Response(
            `<script>alert('Authentication failed: ${result.authError}'); window.close();</script>`,
            {
              headers: { "content-type": "text/html" },
              status: 200
            }
          );
        }
      }
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url);
    if (reqUrl.pathname.endsWith("add-mcp") && request.method === "POST") {
      const mcpServer = (await request.json()) as { url: string; name: string };
      // Use HOST if provided, otherwise it will be derived from the request
      await this.addMcpServer(mcpServer.name, mcpServer.url, this.env.HOST);
      return new Response("Ok", { status: 200 });
    }

    if (
      reqUrl.pathname.endsWith("disconnect-mcp") &&
      request.method === "POST"
    ) {
      const { serverId } = (await request.json()) as { serverId: string };
      await this.removeMcpServer(serverId);
      return new Response("Ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
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
