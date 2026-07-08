import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GreetingDurableObject", () => {
  it("can be used from a bare Durable Object", async () => {
    const id = env.GREETING_DO.idFromName("greet-test");
    const stub = env.GREETING_DO.get(id);
    const response = await stub.fetch(new Request("https://example.com"));

    expect(await response.text()).toBe("hello, durable object");
  });
});
