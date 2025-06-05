import {
  Agent,
  routeAgentRequest,
  type AgentNamespace,
  unstable_callable,
} from "agents";
import { MCPClientManager } from "agents/mcp/client";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
  HOST: string;
};

export class MyAgent extends Agent<Env, never> {
  mcp = new MCPClientManager("my-agent", "1.0.0");

  @unstable_callable()
  async disconnectServers() {
    await this.disconnectMCPServers();
  }

  @unstable_callable()
  async connectServers() {
    await this.connectMCPServers();
  }

  @unstable_callable()
  async addUserMcpServer(name: string, url: string) {
    await this.addMcpServer(name, url, this.env.HOST);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
