import { describe, expect, it } from "vitest";
import { loadCdpSpec } from "../browser/spec";

// A trimmed slice of Chrome's real /json/protocol shape.
const RAW_PROTOCOL = {
  domains: [
    {
      domain: "Page",
      commands: [
        {
          name: "navigate",
          description: "Navigates current page to the given URL.",
          parameters: [
            { name: "url", type: "string", description: "URL to navigate." },
            { name: "transitionType", $ref: "TransitionType", optional: true },
            { name: "frameId", $ref: "FrameId", optional: true }
          ],
          returns: [
            { name: "frameId", $ref: "FrameId" },
            { name: "loaderId", $ref: "Network.LoaderId", optional: true }
          ]
        },
        { name: "enable" }
      ],
      events: [
        {
          name: "frameNavigated",
          parameters: [{ name: "frame", $ref: "Frame" }]
        }
      ],
      types: [
        { id: "FrameId", type: "string" },
        {
          id: "TransitionType",
          type: "string",
          enum: ["link", "typed"],
          experimental: true
        },
        {
          id: "Frame",
          type: "object",
          properties: [
            { name: "id", $ref: "FrameId" },
            {
              name: "adFrameStatus",
              type: "array",
              items: { $ref: "AdFrameType" },
              optional: true
            }
          ]
        }
      ]
    }
  ]
};

// A fresh binding per test, so the per-binding spec cache never leaks.
function fakeBinding() {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST") return Response.json({ sessionId: "session-1" });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/json/protocol")) return Response.json(RAW_PROTOCOL);
      return new Response(null, { status: 404 });
    }
  };
}

describe("loadCdpSpec normalization", () => {
  it("keeps command parameters and return values", async () => {
    const spec = await loadCdpSpec({ browser: fakeBinding() });
    const navigate = spec.domains[0].commands[0];

    expect(navigate.method).toBe("Page.navigate");
    expect(navigate.parameters).toEqual([
      { name: "url", type: "string", description: "URL to navigate." },
      { name: "transitionType", $ref: "Page.TransitionType", optional: true },
      { name: "frameId", $ref: "Page.FrameId", optional: true }
    ]);
    expect(navigate.returns).toEqual([
      { name: "frameId", $ref: "Page.FrameId" },
      { name: "loaderId", $ref: "Network.LoaderId", optional: true }
    ]);
  });

  it("gives commands without parameters empty arrays", async () => {
    const spec = await loadCdpSpec({ browser: fakeBinding() });
    const enable = spec.domains[0].commands[1];

    expect(enable.parameters).toEqual([]);
    expect(enable.returns).toEqual([]);
  });

  it("keeps event parameters and type details", async () => {
    const spec = await loadCdpSpec({ browser: fakeBinding() });
    const [page] = spec.domains;

    expect(page.events[0].parameters).toEqual([
      { name: "frame", $ref: "Page.Frame" }
    ]);
    const types = Object.fromEntries(page.types.map((t) => [t.name, t]));
    expect(types["Page.TransitionType"]).toMatchObject({
      type: "string",
      enum: ["link", "typed"],
      experimental: true,
      properties: []
    });
    expect(types["Page.Frame"].properties).toEqual([
      { name: "id", $ref: "Page.FrameId" },
      {
        name: "adFrameStatus",
        type: "array",
        items: { $ref: "Page.AdFrameType" },
        optional: true
      }
    ]);
  });

  it("qualifies every $ref so it resolves to a type by name", async () => {
    const spec = await loadCdpSpec({ browser: fakeBinding() });
    const [page] = spec.domains;
    const typeNames = new Set(page.types.map((t) => t.name));

    for (const param of page.commands[0].parameters) {
      if (param.$ref) expect(typeNames.has(param.$ref)).toBe(true);
    }
  });
});
