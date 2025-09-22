import { Agent, type AgentNamespace, routeAgentRequest } from "agents";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
  HOST?: string; // Optional - will be derived from request if not provided
};

export class MyAgent extends Agent<Env, never> {
  async onRequest(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url);
    if (reqUrl.pathname.endsWith("add-mcp") && request.method === "POST") {
      const mcpServer = (await request.json()) as { url: string; name: string };
      // Use HOST if provided, otherwise it will be derived from the request
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
