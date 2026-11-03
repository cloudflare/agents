import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("PiHarness on the agents chat-completions wire", () => {
  it("streams tool arguments that gain a __proto__ member without polluting Object.prototype", async () => {
    // pi-durable 1.4.0 merged such a member of a partial commit into
    // Object.prototype, for every object in the isolate.
    const stub = env.PI_WIRE_TEST.getByName(crypto.randomUUID());
    expect(await stub.prompt("weather?")).toEqual({
      status: "done",
      merged: true
    });
    expect(await stub.prototypePolluted()).toBe(false);
  });
});
