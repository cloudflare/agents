import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("MCPClientManager capability", () => {
  it("starts OAuth for a fresh standalone registration", async () => {
    const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());

    const result = (await stub.startFreshOAuthFlow()) as unknown as {
      state: string;
      authUrl?: string;
      clientId?: string;
      error?: string;
    };

    expect(result).toMatchObject({
      state: "authenticating",
      clientId: "test-client-id"
    });
    expect(result.authUrl).toMatch(
      /^https:\/\/auth\.example\.com\/authorize\?/
    );
  });

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
    const state = await stub.prepareOAuthCallback();

    const response = await stub.fetch(
      new Request(
        `https://example.com/callback?state=${encodeURIComponent(state)}&error=denied`
      )
    );
    expect(await response.json()).toMatchObject({
      serverId: "callback-server",
      authSuccess: false
    });
  });
});
