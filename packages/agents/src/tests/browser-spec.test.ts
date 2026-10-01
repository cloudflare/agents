import { describe, expect, it } from "vitest";
import { loadCdpSpec } from "../browser/spec";

function createSpecBinding() {
  const requests: Array<{ url: string; method: string }> = [];
  const browser = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (method === "POST") return Response.json({ sessionId: "throwaway" });
      if (url.endsWith("/json/protocol")) {
        return Response.json({
          domains: [
            {
              domain: "Page",
              commands: [{ name: "navigate" }],
              events: [{ name: "loadEventFired" }]
            }
          ]
        });
      }
      return new Response(null, { status: 204 });
    }
  };
  return { browser, requests };
}

describe("loadCdpSpec", () => {
  it("reads the protocol from an existing session without creating one", async () => {
    const { browser, requests } = createSpecBinding();

    const spec = await loadCdpSpec({ browser, sessionId: "session-7" });

    expect(spec.domains.map((domain) => domain.name)).toEqual(["Page"]);
    expect(requests).toEqual([
      {
        url: "https://localhost/v1/devtools/browser/session-7/json/protocol",
        method: "GET"
      }
    ]);
  });

  it("creates and deletes a throwaway session without a session id", async () => {
    const { browser, requests } = createSpecBinding();

    await loadCdpSpec({ browser });

    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "DELETE"
    ]);
  });
});
