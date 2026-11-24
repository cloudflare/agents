import { describe, expect, it } from "vitest";
import { MCPClientConnection } from "../../mcp/client/connection";

type Sent = { url: string; authorization: string | null };

/** A fake network for one SSE server that moved to another origin. */
function movedSseServer() {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      authorization: new Headers(init?.headers).get("authorization")
    });
    if (url === "https://old.example.com/sse") {
      return new Response("moved", {
        status: 307,
        headers: { location: "https://new.example.com/sse" }
      });
    }
    return new Response("unavailable", { status: 503 });
  };
  return { fetch, sent };
}

describe("MCP transport requests and the URL policy", () => {
  it.each([
    ["eventSourceInit.fetch", "stream"],
    ["fetch", "transport"]
  ] as const)(
    "does not send static headers to the origin an SSE stream redirects to (custom %s)",
    async (_, where) => {
      const server = movedSseServer();
      const connection = new MCPClientConnection(
        new URL("https://old.example.com/sse"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: {
            type: "sse",
            headers: { Authorization: "Bearer static-token" },
            ...(where === "stream"
              ? { eventSourceInit: { fetch: server.fetch } }
              : { fetch: server.fetch }),
            redirectPolicy: "follow"
          },
          client: {}
        }
      );

      const transport = connection.getTransport("sse");
      await transport.start().catch(() => {});
      await transport.close();

      expect(server.sent).toEqual([
        {
          url: "https://old.example.com/sse",
          authorization: "Bearer static-token"
        },
        { url: "https://new.example.com/sse", authorization: null }
      ]);
    }
  );
});
