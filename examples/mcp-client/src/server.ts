import {
  Agent,
  routeAgentRequest,
  type AgentNamespace,
  type Connection,
} from "agents";
import { MCPClientManager } from "agents/mcp/client";
import { z } from "zod";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
};

export class MyAgent extends Agent<Env> {
  private mcp = new MCPClientManager();

  constructor(
    public ctx: DurableObjectState,
    public env: Env
  ) {
    super(ctx, env);
  }

  async onStart(): Promise<void> {
    console.log("Registering servers");
    // connect to the same server twice, which ensures that namespacing works as expected
    await this.mcp.connectToServer(new URL("http://localhost:5174/sse"), {
      name: "mcp-server-1",
      version: "1.0.0",
    });
    await this.mcp.connectToServer(new URL("http://localhost:5174/sse"), {
      name: "mcp-server-2",
      version: "1.0.0",
    });
    console.log("Registered servers");
  }

  onConnect(connection: Connection) {
    console.log("Client connected:", connection.id);
    connection.send(`Welcome! You are connected with ID: ${connection.id}`);
    connection.send(
      `The following MCP servers are connected: ${Object.keys(this.mcp.mcpConnections).join(", ")}`
    );
    connection.send(`Available tools: ${JSON.stringify(this.mcp.listTools())}`);
    connection.send(
      `Available resources: ${JSON.stringify(this.mcp.listResources())}`
    );
    connection.send(
      `Available prompts: ${JSON.stringify(this.mcp.listPrompts())}`
    );
  }

  onClose(connection: Connection) {
    console.log("Client disconnected:", connection.id);
  }

  async onMessage(connection: Connection, message: string) {
    console.log(`Message from client ${connection.id}:`, message);

    // call a tool as a test
    const tools = this.mcp.listTools();
    const res = await this.mcp.callTool(
      {
        ...tools[0],
        arguments: {
          a: 1,
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: Not using the response type, doesn't matter
      z.any() as any,
      { timeout: 1000 }
    );

    // Echo the message back with a timestamp
    const response = `Server received "${message}" at ${new Date().toLocaleTimeString()}`;
    connection.send(`Calling tool: ${tools[0].name}`);
    connection.send(response);
    connection.send(`Called tool ${JSON.stringify(tools[0])}`);
    connection.send(JSON.stringify(res.content));
    console.log("response sent to client:", response);

    // Broadcast to other clients
    for (const conn of this.getConnections()) {
      if (conn.id !== connection.id) {
        conn.send(`Client ${connection.id} says: ${message}`);
        conn.send(`Called tool ${JSON.stringify(tools[0])}`);
        conn.send(JSON.stringify(res.content));
      }
    }
  }

  onRequest(request: Request): Response | Promise<Response> {
    const timestamp = new Date().toLocaleTimeString();
    return new Response(
      `Server time: ${timestamp} - Your request has been processed!`,
      {
        headers: {
          "Content-Type": "text/plain",
        },
      }
    );
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
