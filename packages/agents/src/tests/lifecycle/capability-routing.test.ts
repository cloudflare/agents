import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";

describe("Lifecycle capability routing", () => {
  it("routes messages to the matching local capability", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.routeCapability({ value: "routed" })).toEqual({
      payload: { value: "routed" },
      source: null
    });
  });
});
