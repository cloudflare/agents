import { Agent, type Connection, routeAgentRequest } from "agents";
import { env } from "cloudflare:workers";

export class MyAgent extends Agent {
  onConnect(connection: Connection, ctx: any) {
    // Extract authentication from WebSocket connection
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");
    const userId = url.searchParams.get("userId");

    console.log(`Connection attempt - Token: ${token}, UserId: ${userId}`);

    // Validate authentication
    if (!this.validateAuth(token, userId)) {
      console.log("Authentication failed - closing connection");
      connection.close(1008, "Unauthorized: Invalid or missing authentication");
      return;
    }

    console.log(
      `✅ Authenticated client connected: ${connection.id} (user: ${userId})`
    );
    connection.send(
      `🔐 Welcome ${userId}! You are authenticated with token: ${token?.substring(0, 8)}... (ID: ${connection.id})`
    );
  }

  private validateAuth(token: string | null, userId: string | null): boolean {
    // Example validation logic - in production, validate against your auth service
    if (!token || !userId) {
      console.log("❌ Missing token or userId");
      return false;
    }

    // For demo: accept 'demo-token-123' as valid
    if (token === "demo-token-123" && userId.length > 0) {
      console.log("✅ Valid authentication");
      return true;
    }

    console.log("❌ Invalid token or userId");
    return false;
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

  onRequest(request: Request): Response | Promise<Response> {
    // Handle HTTP authentication for API requests
    const authHeader = request.headers.get("Authorization");
    const apiKey = request.headers.get("X-API-Key");

    console.log(`HTTP Request - Auth: ${authHeader}, API Key: ${apiKey}`);

    if (!this.validateHttpAuth(authHeader, apiKey)) {
      console.log("❌ HTTP Authentication failed");
      return new Response(
        "🚫 Unauthorized - Invalid or missing authentication",
        {
          status: 401,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    console.log("✅ HTTP Authentication successful");
    const timestamp = new Date().toLocaleTimeString();
    return new Response(
      `🔐 Authenticated HTTP request processed at ${timestamp}\n✅ Bearer token and API key validated successfully!`,
      {
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }

  private validateHttpAuth(
    authHeader: string | null,
    apiKey: string | null
  ): boolean {
    // Check Bearer token
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      if (token === "demo-token-123") {
        console.log("✅ Valid Bearer token");
      } else {
        console.log("❌ Invalid Bearer token:", token);
        return false;
      }
    } else {
      console.log("❌ Missing or invalid Authorization header");
      return false;
    }

    // Check API key
    if (apiKey === "demo-api-key") {
      console.log("✅ Valid API key");
      return true;
    } else {
      console.log("❌ Invalid API key:", apiKey);
      return false;
    }
  }
}

export default {
  async fetch(request: Request) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-API-Key",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
};
