import { Agent, callable, routeAgentRequest } from "agents";

export class MyAgent extends Agent {
  onStart() {
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

  @callable()
  async addServer(name: string, url: string) {
    await this.addMcpServer(name, url, {
      callbackHost: this.env.HOST
    });
  }

  @callable()
  async disconnectServer(serverId: string) {
    await this.removeMcpServer(serverId);
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
