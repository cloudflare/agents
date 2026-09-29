import { describe, expect, it } from "vitest";
import { authenticateRequest } from "../src/auth";

describe("bearer authentication", () => {
  it("accepts the configured token", async () => {
    const request = new Request("https://example.com/a2a", {
      headers: { Authorization: "Bearer correct-token" }
    });
    await expect(authenticateRequest(request, "correct-token")).resolves.toBe(
      true
    );
  });

  it.each(["bearer", "BEARER", "bEaReR"])(
    "accepts a case-insensitive %s scheme",
    async (scheme) => {
      const request = new Request("https://example.com/a2a", {
        headers: { Authorization: `${scheme} correct-token` }
      });
      await expect(authenticateRequest(request, "correct-token")).resolves.toBe(
        true
      );
    }
  );

  it("keeps bearer token comparison case-sensitive", async () => {
    const request = new Request("https://example.com/a2a", {
      headers: { Authorization: "bearer Correct-Token" }
    });
    await expect(authenticateRequest(request, "correct-token")).resolves.toBe(
      false
    );
  });

  it("rejects missing, wrong, and empty configured tokens", async () => {
    await expect(
      authenticateRequest(new Request("https://example.com/a2a"), "expected")
    ).resolves.toBe(false);
    await expect(
      authenticateRequest(
        new Request("https://example.com/a2a", {
          headers: { Authorization: "Bearer wrong" }
        }),
        "expected"
      )
    ).resolves.toBe(false);
    await expect(
      authenticateRequest(new Request("https://example.com/a2a"), "")
    ).resolves.toBe(false);
  });
});
