import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  followCallback,
  newAgent,
  restartAgent,
  useOAuthMcpServer,
  type IntegrationAgent
} from "./harness";
import {
  ADMIN_SCOPE,
  CLIENT_ORIGIN,
  MCP_URL,
  READ_SCOPE,
  WRITE_SCOPE
} from "./oauth-mcp-server";

const server = useOAuthMcpServer();

describe("MCP re-authorization in an Agent", () => {
  it("connects through OAuth and calls a tool", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);

    expect(await agent.toolNames()).toEqual(
      expect.arrayContaining(["read", "write"])
    );
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
    expect(await agent.server(id)).toMatchObject({
      state: "ready",
      auth_url: null
    });
  });

  it("returns a link from addMcpServer when the handshake is open but the catalog needs a token", async () => {
    server.options.openHandshake = true;
    const agent = await newAgent();

    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(added.state).toBe("authenticating");
    if (added.state !== "authenticating") throw new Error("unreachable");
    expect(await agent.server(added.id)).toMatchObject({
      state: "authenticating",
      auth_url: added.authUrl
    });

    await followCallback(server.authorize(added.authUrl));
    await agent.settle();
    expect((await agent.server(added.id))?.state).toBe("ready");
  });

  it("asks for a scope step-up mid-session and finishes it through the callback", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });

    const denied = await agent.callServerTool(id, "write");
    expect(denied).toMatchObject({ ok: false, authorizationRequired: true });
    if (denied.ok || !denied.authUrl) throw new Error("expected a link");
    expect(server.requestedScope(denied.authUrl)).toContain(WRITE_SCOPE);
    expect(await agent.server(id)).toMatchObject({
      state: "authenticating",
      auth_url: denied.authUrl
    });

    await followCallback(server.authorize(denied.authUrl));
    await agent.settle();

    expect(await agent.server(id)).toMatchObject({
      state: "ready",
      auth_url: null
    });
    expect(await agent.callServerTool(id, "write")).toEqual({
      ok: true,
      text: "wrote it"
    });
  });

  it("asks the user again when a token expires and the refresh is refused", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);

    server.revokeAccessTokens();
    server.options.refuseRefresh = true;
    const denied = await agent.callServerTool(id, "read");

    expect(denied).toMatchObject({ ok: false, authorizationRequired: true });
    expect(
      server.tokenRequests.some(
        (params) => params.get("grant_type") === "refresh_token"
      )
    ).toBe(true);
    expect((await agent.server(id))?.state).toBe("authenticating");
  });

  it("refreshes an expired token without asking the user", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);

    server.revokeAccessTokens();
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
    expect((await agent.server(id))?.state).toBe("ready");
  });

  it("treats two calls that hit the same step-up as one authorization", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });

    const [first, second] = await Promise.all([
      agent.callServerTool(id, "write"),
      agent.callServerTool(id, "write")
    ]);
    expect(first).toMatchObject({ authorizationRequired: true });
    expect(second).toMatchObject({ authorizationRequired: true });
    const { auth_url } = (await agent.server(id)) ?? {};
    if (!auth_url) throw new Error("expected a link");

    await followCallback(server.authorize(auth_url));
    await agent.settle();
    expect(await agent.callServerTool(id, "write")).toMatchObject({
      ok: true
    });
  });

  it("restores a pending authorization link after a wake while it can still be used", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server, { scope: READ_SCOPE });
    const denied = await before.callServerTool(id, "write");
    if (denied.ok || !denied.authUrl) throw new Error("expected a link");

    const agent = await restartAgent(before);
    expect(await agent.server(id)).toMatchObject({
      state: "authenticating",
      auth_url: denied.authUrl
    });

    await followCallback(server.authorize(denied.authUrl));
    await agent.settle();
    expect(await agent.callServerTool(id, "write")).toMatchObject({
      ok: true
    });
  });
});

/**
 * Call `tool` and approve its step-up `count` times while the authorization
 * server grants only `grant`.
 */
async function completeUnsatisfiedRounds(
  agent: IntegrationAgent,
  id: string,
  tool: string,
  { count = 3, grant = READ_SCOPE } = {}
): Promise<void> {
  for (let round = 1; round <= count; round++) {
    const denied = await agent.callServerTool(id, tool);
    expect(denied, `round ${round}`).toMatchObject({
      authorizationRequired: true
    });
    if (denied.ok || !denied.authUrl) throw new Error("expected a link");
    await followCallback(server.authorize(denied.authUrl, { scope: grant }));
    await agent.settle();
  }
}

describe("MCP step-up round limit in an Agent", () => {
  it("stops after three completed authorizations that never grant the scope, across wakes, until an explicit reconnect", async () => {
    let agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    await completeUnsatisfiedRounds(agent, id, "write");

    const exhausted = await agent.callServerTool(id, "write");
    expect(exhausted).toMatchObject({
      ok: false,
      authorizationRequired: false
    });
    expect(await agent.server(id)).toMatchObject({
      state: "failed",
      auth_url: null
    });
    expect((await agent.server(id))?.error).toContain(WRITE_SCOPE);

    agent = await restartAgent(agent);
    expect((await agent.server(id))?.state).toBe("failed");

    // Adding the server again is an explicit reconnect: it clears the limit.
    const retried = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(retried).toMatchObject({ id, state: "ready" });
    const again = await agent.callServerTool(id, "write");
    expect(again).toMatchObject({ authorizationRequired: true });
  });

  it("keeps each scope set's count when step-ups alternate between two tools", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    for (let round = 0; round < 3; round++) {
      await completeUnsatisfiedRounds(agent, id, "write", { count: 1 });
      await completeUnsatisfiedRounds(agent, id, "admin", { count: 1 });
    }

    expect(await agent.callServerTool(id, "write")).toMatchObject({
      ok: false,
      authorizationRequired: false
    });
    expect((await agent.server(id))?.state).toBe("failed");
  });

  it("counts a scope named like an Object member", async () => {
    // Challenges ask for exactly `constructor` and grants carry no scope, so
    // the client tracks a scope set named like an `Object.prototype` member.
    server.options.challengeScope = ADMIN_SCOPE;
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: "" });
    // The first authorization asked for the same scope set: it is round one.
    await completeUnsatisfiedRounds(agent, id, "admin", {
      count: 2,
      grant: ""
    });

    expect(await agent.callServerTool(id, "admin")).toMatchObject({
      ok: false,
      authorizationRequired: false
    });
    expect((await agent.server(id))?.error).toContain(ADMIN_SCOPE);
  });
});
