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

  it("gives up after a day, stays failed across wakes and when added again, and reconnects on request", async () => {
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

    // Adding it again, as an app does from onStart, reports why it stopped
    // and how to try again, without asking the server.
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(added).toMatchObject({ state: "error" });
    if (added.state !== "error") throw new Error("unreachable");
    expect(added.message).toContain("reconnectMcpServer");
    expect(server.mcpMethods.length).toBe(methodsBefore);

    expect(await agent.reconnect(id)).toMatchObject({ id, state: "ready" });
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

    // Adding it again with an id renames it; it stays failed, waiting for
    // its reconnect, which moves with it.
    const renamed = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    expect(renamed).toMatchObject({ state: "error" });

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
  it("fails a link that expires unused, keeps it failed across wakes and when added again, and offers a new one on request", async () => {
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

    expect(
      await agent.connectServer(MCP_URL, { callbackHost: CLIENT_ORIGIN })
    ).toMatchObject({ state: "error" });

    const again = await agent.reconnect(added.id);
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

describe("MCP servers an app adds again", () => {
  it("reconnects a server that has been down a while when it is added again", async () => {
    const { agent, id } = await serverDownAfterWake();
    server.options.up = true;
    await agent.ageReconnectFailures(id, 31_000);

    expect(
      await agent.connectServer(MCP_URL, { callbackHost: CLIENT_ORIGIN })
    ).toMatchObject({ id, state: "ready" });
    expect(await agent.mcpJobs()).toEqual([]);
  });

  it("replaces a link that can no longer complete when the server is added again", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (first.state !== "authenticating") throw new Error("expected a link");

    // The link's state expires before its expiry job has run.
    await agent.expireOAuthStates();
    const again = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(again.state).toBe("authenticating");
    if (again.state !== "authenticating") throw new Error("unreachable");
    expect(again.authUrl).not.toBe(first.authUrl);
  });

  it("waits out the first backoff step before adding the server again retries it", async () => {
    const { agent, id } = await serverDownAfterWake();
    server.options.up = true;
    const methodsBefore = server.mcpMethods.length;

    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(added).toMatchObject({ state: "error" });
    if (added.state !== "error") throw new Error("unreachable");
    // It reports why the server is down, not a generic failure.
    expect(added.message).toContain("503");
    expect(server.mcpMethods.length).toBe(methodsBefore);
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      `connect:${id}`
    ]);

    await runDueJobs(agent);
    expect((await agent.server(id))?.state).toBe("ready");
  });

  it("returns a pending link instead of starting another flow", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (first.state !== "authenticating") throw new Error("expected a link");

    const again = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(again).toEqual(first);
    expect(server.registeredClients).toHaveLength(1);
  });
});

describe("MCP client registration the authorization server rejects", () => {
  it("stops when registration is refused with a 4xx", async () => {
    server.options.registrationStatus = 400;
    const agent = await newAgent();

    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(added.state).toBe("error");
    const [id] = await agent.serverIds();
    const view = await agent.server(id);
    expect(view?.state).toBe("failed");
    expect(view?.error).toContain("Authorization was refused");
    expect(await agent.mcpJobs()).toEqual([]);
    expect(server.registrationAttempts()).toBe(1);
  });

  it("keeps retrying while registration answers 503", async () => {
    server.options.registrationStatus = 503;
    const agent = await newAgent();

    await agent.connectServer(MCP_URL, { callbackHost: CLIENT_ORIGIN });
    const [id] = await agent.serverIds();
    expect((await agent.mcpJobs()).map((job) => job.id)).toEqual([
      `connect:${id}`
    ]);

    server.options.registrationStatus = undefined;
    await runDueJobs(agent);
    expect((await agent.server(id))?.state).toBe("authenticating");
  });
});

describe("MCP authorization links that never expire on their own", () => {
  it("records a link as expired after a day even when its state could still be redeemed", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");

    await agent.ageAuthorizationLink(added.id, DAY_MS + 1);
    await runDueJobs(agent);

    const view = await agent.server(added.id);
    expect(view).toMatchObject({ state: "failed", auth_url: null });
    expect(view?.error).toContain("Authorization expired");
    expect(await agent.mcpJobs()).toEqual([]);
  });
});
