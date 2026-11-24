import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MCPClientConnection } from "../../mcp/client/connection";

type Sent = { url: string; authorization: string | null };

// One SSE server that moved to another origin, served through msw.
const sent: Sent[] = [];
const record = (request: Request) =>
  sent.push({
    url: request.url,
    authorization: request.headers.get("authorization")
  });
const msw = setupServer(
  http.get("https://old.example.com/sse", ({ request }) => {
    record(request as unknown as Request);
    return new HttpResponse("moved", {
      status: 307,
      headers: { location: "https://new.example.com/sse" }
    });
  }),
  http.get("https://new.example.com/sse", ({ request }) => {
    record(request as unknown as Request);
    return new HttpResponse("unavailable", { status: 503 });
  })
);
beforeAll(() => msw.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  sent.length = 0;
});
afterAll(() => msw.close());

/** An app's own fetch, as a custom transport option. */
const appFetch = (input: string | URL, init?: RequestInit) =>
  fetch(input, init);

describe("MCP transport requests and the URL policy", () => {
  it.each([
    ["eventSourceInit.fetch", "stream"],
    ["fetch", "transport"]
  ] as const)(
    "does not send static headers to the origin an SSE stream redirects to (custom %s)",
    async (_, where) => {
      const connection = new MCPClientConnection(
        new URL("https://old.example.com/sse"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: {
            type: "sse",
            headers: { Authorization: "Bearer static-token" },
            ...(where === "stream"
              ? { eventSourceInit: { fetch: appFetch } }
              : { fetch: appFetch }),
            redirectPolicy: "follow"
          },
          client: {}
        }
      );

      const transport = connection.getTransport("sse");
      await transport.start().catch(() => {});
      await transport.close();

      expect(sent).toEqual([
        {
          url: "https://old.example.com/sse",
          authorization: "Bearer static-token"
        },
        { url: "https://new.example.com/sse", authorization: null }
      ]);
    }
  );
});
