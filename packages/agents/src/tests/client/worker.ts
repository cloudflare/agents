import {
  Agent,
  routeAgentRequest,
  type AgentNamespace,
  unstable_callable,
} from "../../";
import { MCPClientManager } from "../../mcp/client";

export type Env = {
  McpClient: AgentNamespace<McpClient>;
  HOST: string;
};

export class McpClient extends Agent<Env, never> {
  mcp = new MCPClientManager("my-agent", "1.0.0");

  resetInMemoryMcp() {
    this.mcp = new MCPClientManager("my-agent", "1.0.0");
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
