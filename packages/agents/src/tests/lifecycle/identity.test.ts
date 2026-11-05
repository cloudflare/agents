import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";

describe("Lifecycle identity", () => {
  it("reads an old __ps_name record without writing new fallback state", async () => {
    const id = env.PlainLifecycleObject.newUniqueId();
    const stub = env.PlainLifecycleObject.get(id);
    await stub.seedLegacyNameForTest("migrated-name");

    const response = await stub.fetch(new Request("https://example.com"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "migrated-name" });
  });

  it("does not send internal error details to the caller", async () => {
    const stub = env.PlainLifecycleObject.get(
      env.PlainLifecycleObject.newUniqueId()
    );
    const response = await stub.fetch(new Request("https://example.com"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe("Internal Server Error");
  });
});
