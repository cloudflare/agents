import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * `browserTool` from `agents/browser/pi`, run by pi itself: pi validates
 * the call against the tool's schema, runs it as a durable task, and
 * stores the result, image included, in the transcript.
 */
describe("the pi browser tool in a harness", () => {
  it("runs a model's browser call and stores the screenshot as an image", async () => {
    const harness = env.PI_BROWSER_TEST.get(
      env.PI_BROWSER_TEST.idFromName(crypto.randomUUID())
    );
    const response = await harness.prompt("take a screenshot");

    expect(response.status).toBe("done");
    expect(response.text).toBe("browser returned: text,image");
    expect(response.parts).toHaveLength(2);
    expect(response.parts[0]).toMatch(
      /^text .*Screenshot attached as an image/
    );
    expect(response.parts[1]).toBe("image image/png aGVsbG8=");
    expect(JSON.parse(response.details)).toMatchObject({
      status: "completed"
    });
  });
});
