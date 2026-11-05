import { env } from "cloudflare:workers";

import { describe, expect, it, vi } from "vitest";

describe("Lifecycle identity", () => {
  it("reads an old __ps_name record without writing new fallback state", async () => {
    const id = env.PlainLifecycleObject.newUniqueId();
    const stub = env.PlainLifecycleObject.get(id);
    await stub.seedLegacyNameForTest("migrated-name");

    const response = await stub.fetch(new Request("https://example.com"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "migrated-name" });
  });

  it("logs identity remedies without sending them to the caller", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stub = env.PlainLifecycleObject.get(
        env.PlainLifecycleObject.newUniqueId()
      );
      const response = await stub.fetch(new Request("https://example.com"));
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).toBe("Internal Server Error");

      const logged = errors.mock.calls
        .flat()
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join("\n");
      expect(logged).toContain("idFromName() or getByName()");
      expect(logged).toContain("update Wrangler/workerd");
      expect(logged).toContain("compatibility_date");
      expect(logged).toContain("2026-03-15");
    } finally {
      errors.mockRestore();
    }
  });
});
