import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
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

  describe("durable connection jobs", () => {
    type Job = { id: string; fn: string; time: number; payload: unknown };

    it("reconnects a failed server from the job queue with backoff", async () => {
      const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());
      await stub.prepareFlakyServer();

      expect(await stub.connectionStatus("flaky")).toMatchObject({
        state: "failed"
      });
      const [first] = (await stub.mcpJobs()) as Job[];
      expect(first).toMatchObject({
        id: "connect:flaky",
        fn: "connect",
        payload: { serverId: "flaky", attempt: 1 }
      });

      // Still down when the alarm drives the job: the next attempt backs off.
      await stub.backdateMcpJobs();
      await runDurableObjectAlarm(stub);
      const [second] = (await stub.mcpJobs()) as Job[];
      expect(second).toMatchObject({
        id: "connect:flaky",
        payload: { serverId: "flaky", attempt: 2 }
      });
      expect(second.time).toBeGreaterThan(Date.now() + 30_000);

      // Back up: the next drive connects and the job is gone.
      await stub.allowFlakyServer();
      await stub.backdateMcpJobs();
      await runDurableObjectAlarm(stub);
      expect(await stub.connectionStatus("flaky")).toMatchObject({
        state: "ready"
      });
      expect(await stub.mcpJobs()).toEqual([]);
    });

    it("fails an authorization link that expires unused, and keeps it failed after eviction", async () => {
      const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());
      const started = (await stub.startFreshOAuthFlow()) as unknown as {
        state: string;
        authUrl?: string;
      };
      expect(started.state).toBe("authenticating");
      expect((await stub.mcpJobs()) as Job[]).toMatchObject([
        {
          id: "auth-expiry:fresh-oauth-server",
          fn: "auth-expiry",
          payload: {
            serverId: "fresh-oauth-server",
            authUrl: started.authUrl
          }
        }
      ]);

      await stub.expireOAuthStates();
      await stub.backdateMcpJobs();
      await runDurableObjectAlarm(stub);

      const expired = await stub.connectionStatus("fresh-oauth-server");
      expect(expired?.state).toBe("failed");
      expect(expired?.error).toContain("Authorization expired");
      expect(await stub.mcpJobs()).toEqual([]);

      await evictDurableObject(stub);
      const response = await stub.fetch(new Request("https://example.com"));
      expect(await response.json()).toMatchObject({
        states: { "fresh-oauth-server": "failed" }
      });
    });
  });
});
