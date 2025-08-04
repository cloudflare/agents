import { Agent, type Connection, routeAgentRequest } from "agents";
import { env } from "cloudflare:workers";

export class MyAgent extends Agent {
  onConnect(connection: Connection) {
    console.log("Client connected:", connection.id);
    connection.send(`Welcome! You are connected with ID: ${connection.id}`);
  }

  onClose(connection: Connection) {
    console.log("Client disconnected:", connection.id);
  }

  onMessage(connection: Connection, message: string) {
    console.log(`Message from client ${connection.id}:`, message);

    // Echo the message back with a timestamp
    const response = `Server received "${message}" at ${new Date().toLocaleTimeString()}`;
    connection.send(response);
    console.log("response sent to client:", response);

    // Broadcast to other clients
    for (const conn of this.getConnections()) {
      if (conn.id !== connection.id) {
        conn.send(`Client ${connection.id} says: ${message}`);
      }
    }
  }

  onRequest(_request: Request): Response | Promise<Response> {
    const timestamp = new Date().toLocaleTimeString();
    return new Response(
      `Server time: ${timestamp} - Your request has been processed!`,
      {
        headers: {
          "Content-Type": "text/plain"
        }
      }
    );
  }
}

export default {
  async fetch(request: Request) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
};
