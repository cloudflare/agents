import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * `web_search` and `web_fetch` from `agents/websearch/pi` and
 * `agents/webfetch/pi`, run by pi itself, called by the model and by a code
 * mode script.
 */
describe("the pi web tools in a harness", () => {
  it("gives the model the rendered text on a direct call", async () => {
    const harness = env.PI_WEB_TEST.get(
      env.PI_WEB_TEST.idFromName(crypto.randomUUID())
    );
    const response = await harness.prompt("search");

    expect(response.status).toBe("done");
    expect(response.parts).toHaveLength(1);
    expect(response.parts[0]).toMatch(/^2 results for "workers":/);
  });

  it("gives a codemode script objects, and rejects a failed fetch", async () => {
    const harness = env.PI_WEB_TEST.get(
      env.PI_WEB_TEST.idFromName(crypto.randomUUID())
    );
    const response = await harness.prompt("codemode");

    expect(response.status).toBe("done");
    expect(response.parts[0]).toMatch(/^Script completed/);
    expect(JSON.parse(response.parts.at(-1)!)).toEqual({
      query: "workers",
      titles: ["Page short", "Page long"],
      first: "<untrusted_web_content>\nShort page.\n</untrusted_web_content>",
      windows: 3,
      failed: expect.stringContaining("https://example.com/missing")
    });
  });
});
