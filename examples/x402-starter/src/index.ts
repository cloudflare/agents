import { X402Agent } from "./agent";
import { X402MCP } from "./mcp-server";

// Export Durable Object classes - Agents are Durable Objects
export { X402Agent, X402MCP };

// Main worker that routes requests to appropriate Durable Objects
export default {
  async fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Route MCP requests to X402MCP Durable Object
    if (url.pathname.startsWith("/mcp")) {
      const id = env.X402_MCP.idFromName("default");
      const stub = env.X402_MCP.get(id);
      return stub.fetch(request);
    }

    // Only route API and chat requests to X402Agent
    if (
      url.pathname.startsWith("/api") ||
      url.pathname === "/chat" ||
      url.pathname.startsWith("/parties")
    ) {
      const id = env.X402_AGENT.idFromName("default");
      const stub = env.X402_AGENT.get(id);

      // Add required headers for PartyKit compatibility
      const headers = new Headers(request.headers);
      headers.set("x-partykit-namespace", "x402-agent");
      headers.set("x-partykit-room", "default");

      const modifiedRequest = new Request(request, { headers });
      return stub.fetch(modifiedRequest);
    }

    // For root and other paths, return a simple response
    // (In production, this would serve your static assets)
    return new Response("X402 AI Starter API", {
      headers: { "Content-Type": "text/plain" }
    });
  }
};
