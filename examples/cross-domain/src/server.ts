import {
  Agent,
  routeAgentRequest,
  type AgentNamespace,
  type Connection,
} from "agents-sdk";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
};

export class MyAgent extends Agent<Env> {
  onConnect(connection: Connection) {
    console.log("connected to client:", connection.id);
    connection.send("message from server");
  }
  onMessage(connection: Connection, message: string) {
    console.log("message from client", message);
  }
  onRequest(request: Request): Response | Promise<Response> {
    return new Response("response from server");
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
