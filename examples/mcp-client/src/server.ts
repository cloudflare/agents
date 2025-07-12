import { Agent, type AgentNamespace, routeAgentRequest } from "agents";
import { MCPClientManager } from "agents/mcp/client";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
  HOST: string;
};

export class MyAgent extends Agent<Env, never> {
  mcp = new MCPClientManager("my-agent", "1.0.0");

  async onRequest(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url);
    if (reqUrl.pathname.endsWith("add-mcp") && request.method === "POST") {
      const mcpServer = (await request.json()) as { url: string; name: string };
      await this.addMcpServer(mcpServer.name, mcpServer.url, this.env.HOST);
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
