import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("AIChatAgent onFetchError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("receives the original error when onError returns instead of rethrowing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await env.LogOnlyOnErrorAgent.getByName(
      crypto.randomUUID()
    ).fetch("https://example.com/");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "chat request failed" });
  });
});
