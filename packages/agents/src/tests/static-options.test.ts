import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Agent static options", () => {
  it("keeps hibernation enabled when a subclass overrides another option", async () => {
    const room = `partial-static-options-${crypto.randomUUID()}`;
    const response = await exports.default.fetch(
      `http://example.com/agents/test-no-identity-agent/${room}`,
      { headers: { Upgrade: "websocket" } }
    );

    expect(response.status).toBe(101);
    const client = response.webSocket;
    expect(client).toBeDefined();
    client?.accept();

    const stub = env.TestNoIdentityAgent.getByName(room);
    const result = await runInDurableObject(stub, (instance, ctx) => ({
      hibernate: (
        instance.constructor as typeof instance.constructor & {
          options: { hibernate?: boolean };
        }
      ).options.hibernate,
      hibernatingConnections: ctx.getWebSockets().length
    }));

    expect(result.hibernate).toBe(true);
    expect(result.hibernatingConnections).toBe(1);

    client?.close();
  });
});
