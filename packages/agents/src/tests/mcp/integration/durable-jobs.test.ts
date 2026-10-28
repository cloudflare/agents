import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  followCallback,
  newAgent,
  restartAgent,
  useOAuthMcpServer,
  type IntegrationAgent
} from "./harness";
import { CLIENT_ORIGIN, MCP_URL } from "./oauth-mcp-server";

const server = useOAuthMcpServer();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Make the agent's MCP jobs due and run its alarm. */
async function runDueJobs(agent: IntegrationAgent): Promise<void> {
  await agent.backdateMcpJobs();
  await runDurableObjectAlarm(agent);
  await agent.settle();
}

/** A ready server whose resource server then goes down across a wake. */
async function serverDownAfterWake(): Promise<{
  agent: IntegrationAgent;
  id: string;
}> {
  const before = await newAgent();
  const id = await connectAuthorized(before, server);
  server.options.up = false;
  const agent = await restartAgent(before);
  await agent.settle();
  expect((await agent.server(id))?.state).toBe("failed");
  return { agent, id };
}

describe("MCP durable reconnects in an Agent", () => {
  it("retries a server that went down on the job queue, backing off, until it is back", async () => {
    const { agent, id } = await serverDownAfterWake();
    const [first] = await agent.mcpJobs();
    expect(first).toMatchObject({
      id: `connect:${id}`,
      payload: { serverId: id, attempt: 1 }
    });

    await runDueJobs(agent);
    const [second] = await agent.mcpJobs();
    expect(second).toMatchObject({ payload: { attempt: 2 } });
    expect(second.time).toBeGreaterThan(Date.now() + 30_000);
    expect((await agent.server(id))?.state).toBe("failed");

    server.options.up = true;
    await runDueJobs(agent);
    expect((await agent.server(id))?.state).toBe("ready");
    expect(await agent.mcpJobs()).toEqual([]);
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });

  it("waits for the scheduled attempt when the object wakes for another reason", async () => {
    const { agent: down, id } = await serverDownAfterWake();
    server.options.up = true;
    const methodsBefore = server.mcpMethods.length;

    const agent = await restartAgent(down);
    await agent.settle();
    expect((await agent.server(id))?.state).toBe("failed");
    expect(server.mcpMethods.length).toBe(methodsBefore);

    await runDueJobs(agent);
    expect((await agent.server(id))?.state).toBe("ready");
  });

  it("gives up after a day, stays failed across wakes, and reconnects when the server is added again", async () => {
    const { agent: down, id } = await serverDownAfterWake();
    await down.ageReconnectFailures(id, DAY_MS + 1);
    await runDueJobs(down);

    const failed = await down.server(id);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toContain("Stopped reconnecting");
    expect(await down.mcpJobs()).toEqual([]);

    server.options.up = true;
    const methodsBefore = server.mcpMethods.length;
    const agent = await restartAgent(down);
    await agent.settle();
    expect((await agent.server(id))?.state).toBe("failed");
    expect(server.mcpMethods.length).toBe(methodsBefore);

    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(added).toMatchObject({ id, state: "ready" });
  });

  it("moves pending jobs when a server is given a stable id", async () => {
    const before = await newAgent();
    const generated = await connectAuthorized(before, server);
    server.options.up = false;
    const agent = await restartAgent(before);
    await agent.settle();
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      `connect:${generated}`
    ]);

    // Adding it again with an id renames it and tries once more; the server
    // is still down, so that attempt fails.
    const renamed = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    expect(renamed).toMatchObject({ state: "error" });
    if (renamed.state !== "error") throw new Error("unreachable");
    expect(renamed.message).toContain("503");

    expect(await agent.serverIds()).toEqual(["files"]);
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      "connect:files"
    ]);
    server.options.up = true;
    await runDueJobs(agent);
    expect((await agent.server("files"))?.state).toBe("ready");
  });
});

describe("MCP durable jobs and the rest of the flow", () => {
  it("retries a server that was down when it was added, and asks for authorization once it is back", async () => {
    server.options.up = false;
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(added.state).toBe("error");
    const [id] = await agent.serverIds();
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      `connect:${id}`
    ]);

    server.options.up = true;
    await runDueJobs(agent);
    const server_ = await agent.server(id);
    expect(server_?.state).toBe("authenticating");
    expect(server_?.auth_url).toBeTruthy();
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      `auth-expiry:${id}`
    ]);
  });

  it("asks the user when a reconnect finds the grant can no longer be refreshed", async () => {
    const { agent, id } = await serverDownAfterWake();
    server.revokeAccessTokens();
    server.options.refuseRefresh = true;
    server.options.up = true;

    await runDueJobs(agent);
    const view = await agent.server(id);
    expect(view?.state).toBe("authenticating");
    if (!view?.auth_url) throw new Error("expected a link");
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      `auth-expiry:${id}`
    ]);

    await followCallback(server.authorize(view.auth_url));
    await agent.settle();
    expect((await agent.server(id))?.state).toBe("ready");
  });

  it("cancels a server's pending jobs when it is removed", async () => {
    const { agent, id } = await serverDownAfterWake();
    expect(await agent.mcpJobs()).toHaveLength(1);
    await agent.remove(id);
    expect(await agent.mcpJobs()).toEqual([]);

    server.options.up = true;
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "pending"
    });
    expect(added.state).toBe("authenticating");
    expect(await agent.mcpJobs()).toHaveLength(1);
    await agent.remove("pending");
    expect(await agent.mcpJobs()).toEqual([]);
  });
});

describe("MCP authorization link expiry in an Agent", () => {
  it("fails a link that expires unused, keeps it failed across wakes, and offers a new one when added again", async () => {
    const before = await newAgent();
    const added = await before.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");
    expect(await before.mcpJobs()).toMatchObject([
      { id: `auth-expiry:${added.id}`, payload: { authUrl: added.authUrl } }
    ]);

    await before.expireOAuthStates();
    await runDueJobs(before);
    const expired = await before.server(added.id);
    expect(expired).toMatchObject({ state: "failed", auth_url: null });
    expect(expired?.error).toContain("Authorization expired");

    const agent = await restartAgent(before);
    expect((await agent.server(added.id))?.state).toBe("failed");

    // The user finally clicks the dead link: nothing connects.
    await followCallback(server.authorize(added.authUrl));
    await agent.settle();
    expect((await agent.server(added.id))?.state).toBe("failed");

    const again = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(again.state).toBe("authenticating");
    if (again.state !== "authenticating") throw new Error("unreachable");
    expect(again.authUrl).not.toBe(added.authUrl);
  });

  it("records a link that expired while the object was asleep as failed on wake", async () => {
    const before = await newAgent();
    const added = await before.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");

    await before.expireOAuthStates();
    const agent = await restartAgent(before);

    const woken = await agent.server(added.id);
    expect(woken).toMatchObject({ state: "failed", auth_url: null });
    expect(woken?.error).toContain("Authorization expired");
    expect(await agent.mcpJobs()).toEqual([]);
  });
});

describe("MCP refused authorization in an Agent", () => {
  it("stops after one attempt when the server refuses access with a 403, and connects again once it allows access", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);

    server.options.forbidden = true;
    const agent = await restartAgent(before);
    await agent.settle();

    const refused = await agent.server(id);
    expect(refused?.state).toBe("failed");
    expect(refused?.error).toContain("Authorization was refused");
    expect(await agent.mcpJobs()).toEqual([]);
    expect(server.forbiddenResponses()).toBe(1);

    // Later wakes stay failed without asking the server again.
    const woken = await restartAgent(agent);
    await woken.settle();
    expect((await woken.server(id))?.state).toBe("failed");
    expect(server.forbiddenResponses()).toBe(1);

    server.options.forbidden = false;
    expect(await woken.connectNow(id)).toMatchObject({ state: "connected" });
  });

  it("stops when the authorization server refuses the refresh with invalid_target", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);

    server.revokeAccessTokens();
    server.options.tokenError = "invalid_target";
    const agent = await restartAgent(before);
    await agent.settle();

    const refused = await agent.server(id);
    expect(refused?.state).toBe("failed");
    expect(refused?.error).toContain("Authorization was refused");
    expect(await agent.mcpJobs()).toEqual([]);
    const refreshes = server.tokenRequests.filter(
      (params) => params.get("grant_type") === "refresh_token"
    );
    expect(refreshes).toHaveLength(1);
  });

  it("keeps retrying while the authorization server is temporarily unavailable", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);

    server.revokeAccessTokens();
    server.options.tokenError = "temporarily_unavailable";
    const agent = await restartAgent(before);
    await agent.settle();
    expect((await agent.server(id))?.state).toBe("failed");
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      `connect:${id}`
    ]);

    server.options.tokenError = undefined;
    await runDueJobs(agent);
    expect((await agent.server(id))?.state).toBe("ready");
  });

  it.each([
    { label: "without an OAuth callback", callbackHost: undefined },
    { label: "with an OAuth callback", callbackHost: CLIENT_ORIGIN }
  ])(
    "stops after one attempt when a static token is revoked, $label",
    async ({ callbackHost }) => {
      server.options.staticToken = "key-1";
      const before = await newAgent();
      const added = await before.connectServer(server.url, {
        callbackHost,
        headers: { Authorization: "Bearer key-1" }
      });
      expect(added.state).toBe("ready");
      if (added.state !== "ready") throw new Error("unreachable");

      server.options.staticToken = "key-2";
      const agent = await restartAgent(before);
      await agent.settle();

      const refused = await agent.server(added.id);
      expect(refused?.state).toBe("failed");
      expect(refused?.error).toContain("Authorization was refused");
      expect(await agent.mcpJobs()).toEqual([]);

      // Later wakes stay failed without asking the server again.
      const requests = server.unauthorizedMethods.length;
      const woken = await restartAgent(agent);
      await woken.settle();
      expect((await woken.server(added.id))?.state).toBe("failed");
      expect(server.unauthorizedMethods).toHaveLength(requests);
    }
  );
});
