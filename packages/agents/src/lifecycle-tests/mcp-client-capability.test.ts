import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("MCPClientManager capability", () => {
  it("restores persisted connections after eviction", async () => {
    const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());
    await stub.prepareRestorableServer();

    await evictDurableObject(stub);

    const response = await stub.fetch(new Request("https://example.com"));
    expect(await response.json()).toEqual({
      connectionIds: ["server"],
      states: { server: "authenticating" },
      storedServerCount: 1
    });
  });

  it("intercepts registered OAuth callback URLs", async () => {
    const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());
    await stub.prepareOAuthCallback();

    const response = await stub.fetch(
      new Request(
        "https://example.com/callback?state=nonce.callback-server&error=denied"
      )
    );
    expect(await response.json()).toMatchObject({
      serverId: "callback-server",
      authSuccess: false
    });
  });
});
