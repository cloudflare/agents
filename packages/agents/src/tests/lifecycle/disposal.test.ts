import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";

describe("Lifecycle disposal", () => {
  it("disposes live capability resources in reverse registration order", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.disposeCapabilities()).toEqual([
      "dispose:second",
      "dispose:first"
    ]);
  });
});
