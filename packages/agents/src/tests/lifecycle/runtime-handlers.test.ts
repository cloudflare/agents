import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";

async function routePlainObject(url: string): Promise<Response> {
  const response = await routeAgentRequest(new Request(url), env, {
    props: { label: "routed" }
  });
  expect(response).not.toBeNull();
  // SAFETY: asserted non-null above.
  return response as Response;
}

describe("Lifecycle runtime handlers", () => {
  it("installs fetch and dispatches startup, capabilities, then the host", async () => {
    const name = crypto.randomUUID();
    const response = await routePlainObject(
      `https://example.com/agents/plain-lifecycle-object/${name}`
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name,
      hasInternalPropsHeader: false,
      events: [
        "capability:start:routed",
        "host:start:routed",
        "capability:request",
        "host:request"
      ]
    });
  });

  it("rejects installing runtime handlers twice", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.installHandlersAgainForTest()).toBe(
      "Durable Object lifecycle handlers are already installed"
    );
  });

  it("lets the first capability response intercept a request", async () => {
    const name = crypto.randomUUID();
    const response = await routePlainObject(
      `https://example.com/agents/plain-lifecycle-object/${name}?capability`
    );

    expect(await response.json()).toEqual([
      "capability:start:routed",
      "host:start:routed",
      "capability:request"
    ]);
  });
});
