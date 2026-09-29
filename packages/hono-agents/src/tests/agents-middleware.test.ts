/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import type { AgentOptions } from "agents";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { agentsMiddleware } from "../index";

type HonoAgentsTestEnv = {
  Bindings: Cloudflare.Env;
};

function createTestApp(options?: AgentOptions<Cloudflare.Env>) {
  const app = new Hono<HonoAgentsTestEnv>();
  app.use("*", agentsMiddleware<HonoAgentsTestEnv>({ options }));
  app.all("*", (c) => c.text("Downstream response", 418));
  return app;
}

async function fetchWebSocketRequest(
  app: Hono<HonoAgentsTestEnv>,
  path: string
): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      headers: { Upgrade: "websocket" }
    }),
    env,
    createExecutionContext()
  );
}

describe("agentsMiddleware WebSocket routing", () => {
  it("preserves an onBeforeConnect rejection response", async () => {
    const app = createTestApp({
      onBeforeConnect: () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" }
        })
    });

    const response = await fetchWebSocketRequest(
      app,
      "/agents/test-hono-agent/rejected"
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.text()).toBe("Unauthorized");
  });

  it("continues through Hono when no Agent route matches", async () => {
    const response = await fetchWebSocketRequest(
      createTestApp(),
      "/not-an-agent-route"
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("Downstream response");
  });

  it("returns successful WebSocket upgrades", async () => {
    const response = await fetchWebSocketRequest(
      createTestApp(),
      "/agents/test-hono-agent/connected"
    );

    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});
