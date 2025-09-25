import { Agent, type Connection, routeAgentRequest } from "agents";
import { env } from "cloudflare:workers";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Max-Age": "86400"
};

export class MyAgent extends Agent {
  onConnect(connection: Connection, ctx: { request: Request }) {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");
    const userId = url.searchParams.get("userId");

    console.log(
      `✅ Authenticated client connected: ${connection.id} (user: ${userId})`
    );
    connection.send(
      `🔐 Welcome ${userId}! You are authenticated with token: ${token?.substring(0, 8)}...`
    );
  }

  onClose(connection: Connection) {
    console.log("Client disconnected:", connection.id);
  }

  onMessage(connection: Connection, message: string) {
    console.log(`Message from client ${connection.id}:`, message);

    const response = `Server received "${message}" at ${new Date().toLocaleTimeString()}`;
    connection.send(response);
    console.log("response sent to client:", response);

    for (const conn of this.getConnections()) {
      if (conn.id !== connection.id) {
        conn.send(`Client ${connection.id} says: ${message}`);
      }
    }
  }

  onRequest(_request: Request): Response | Promise<Response> {
    const timestamp = new Date().toLocaleTimeString();
    return new Response(
      `🔐 Authenticated HTTP request processed at ${timestamp}\n✅ Bearer token and API key validated successfully!`
    );
  }
}

function authMiddleware(request: Request): Response | Request {
  const url = new URL(request.url);
  // URL params can make it into application logs. Make sure
  // you're not logging long-lived tokens
  let token: string | null | undefined = url.searchParams.get("token");
  if (!token) token = request.headers.get("Authorization")?.substring(7);

  // We found token
  if (token) {
    console.log("Token found:", token);
    // Super strong token authentication :)
    if (token === "demo-token-123") {
      // Continues the request flow
      return request;
    }
  }

  // Interrupt the request by returning a 401 response
  console.log("Authentication failed");
  return new Response("Unauthorized: Invalid or missing authentication", {
    status: 401
  });
}

export default {
  async fetch(request: Request) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: CORS_HEADERS
      });
    }

    // Route agent requests with authentication middleware
    return (
      (await routeAgentRequest(request, env, {
        cors: true,
        onBeforeConnect: async (request: Request) => {
          console.log("🔍 onBeforeConnect called!");
          return authMiddleware(request);
        },
        onBeforeRequest: async (request: Request) => {
          console.log("🔍 onBeforeRequest called!");
          return authMiddleware(request);
        }
      })) || new Response("Not found", { status: 404 })
    );
  }
};
