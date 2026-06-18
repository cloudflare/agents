import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("generated virtual Think entry", () => {
  it("delegates to a custom app server before falling through", async () => {
    const response = await exports.default.fetch("https://example.com/app");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("app route");
  });

  it("routes friendly agent URLs through the generated manifest", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/agents/support/generated-entry",
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("routes friendly URLs to custom Wrangler binding names", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/agents/sales/custom-binding",
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("also accepts custom Wrangler binding names on default routes", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/agents/SalesDirectory/custom-binding-name",
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("routes duplicate child aliases through parent-scoped manifest entries", async () => {
    const support = await exports.default.fetch(
      "https://example.com/api/agents/support/parent/sub/researcher/child",
      { headers: { Upgrade: "websocket" } }
    );
    const sales = await exports.default.fetch(
      "https://example.com/api/agents/sales/parent/sub/researcher/child",
      { headers: { Upgrade: "websocket" } }
    );

    expect(support.status).toBe(101);
    expect(sales.status).toBe(101);
    support.webSocket?.accept();
    support.webSocket?.close();
    sales.webSocket?.accept();
    sales.webSocket?.close();
  });

  it("drills into a declarative agent() sub-agent via the generated facet class", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/agents/sales/parent/sub/analyst/child",
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("lets custom app routes explicitly delegate subagent tails", async () => {
    const response = await exports.default.fetch(
      "https://example.com/custom/support/sub/researcher/child",
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("returns 404 instead of forwarding unresolved subagent tails", async () => {
    const response = await exports.default.fetch(
      "https://example.com/custom/support/sub/missing/child",
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(404);
  });

  it("keeps generated subagent names compatible with registry gates", async () => {
    const response = await exports.default.fetch(
      "https://example.com/custom-gated/support/sub/researcher/gated-child",
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("exports generated Durable Object classes", () => {
    expect(Reflect.get(exports, "ThinkAgent_Support")).toBeDefined();
    expect(Reflect.get(exports, "ThinkAgent_Sales")).toBeDefined();
  });
});
