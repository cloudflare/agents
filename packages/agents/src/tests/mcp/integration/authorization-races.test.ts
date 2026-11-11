import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  eventually,
  followCallback,
  newAgent,
  pause,
  restartAgent,
  waitingAtServer,
  useOAuthMcpServer
} from "./harness";
import { CLIENT_ORIGIN, MCP_URL, READ_SCOPE } from "./oauth-mcp-server";

const server = useOAuthMcpServer();

/**
 * Replays of the bug paths TLA+ models of the MCP client module found, step
 * for step. Each names the rule it checks and the model it comes from.
 */

describe("a server's OAuth storage after it is removed", () => {
  // McpOAuthCallback.tla, rule TokensDieWithServer. Path: the wake's
  // connect refreshes an expired token; the server is removed while the
  // refresh waits at the token endpoint; the refresh returns and saves the
  // new token.
  it("keeps no token that a connect's refresh saved after the removal", async () => {
    const before = await newAgent();
    await connectAuthorized(before, server, undefined, { id: "files" });
    server.revokeAccessTokens();
    const release = server.holdRequests("token");
    const agent = await restartAgent(before);
    await waitingAtServer(server);

    await agent.remove("files");
    expect(await agent.oauthKeys("files")).toEqual([]);
    release();
    await agent.settle();
    await pause();

    expect(await agent.serverIds()).toEqual([]);
    expect(await agent.oauthKeys("files")).toEqual([]);
  });

  // Same rule. Path: a tool call's 401 refreshes the token outside the
  // lane; the server is removed meanwhile; the refresh returns.
  it("keeps no token that a request's refresh saved after the removal", async () => {
    const agent = await newAgent();
    await connectAuthorized(agent, server, undefined, { id: "files" });
    server.revokeAccessTokens();
    const release = server.holdRequests("token");
    const call = agent.callServerTool("files", "read");
    await waitingAtServer(server);

    await agent.remove("files");
    release();
    await call;
    await pause();

    expect(await agent.oauthKeys("files")).toEqual([]);
  });

  // Same rule. Path: as above, but the connection is closed first and the
  // server removed afterwards, so removeServer has no connection to take
  // the provider from.
  it("keeps no token that a closed connection's refresh saved after the removal", async () => {
    const agent = await newAgent();
    await connectAuthorized(agent, server, undefined, { id: "files" });
    server.revokeAccessTokens();
    const release = server.holdRequests("token");
    const call = agent.callServerTool("files", "read");
    await waitingAtServer(server);

    await agent.closeNow("files");
    await agent.remove("files");
    release();
    await call;
    await pause();

    expect(await agent.oauthKeys("files")).toEqual([]);
  });

  // Same rule. Path: as above, but the server is added again after the
  // close, which creates a new connection and provider, and then removed.
  it("keeps no token that a closed connection's refresh saved after the server was added again and removed", async () => {
    const agent = await newAgent();
    await connectAuthorized(agent, server, undefined, { id: "files" });
    server.revokeAccessTokens();
    const release = server.holdRequests("token");
    const call = agent.callServerTool("files", "read");
    await waitingAtServer(server);

    await agent.closeNow("files");
    await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    await agent.remove("files");
    release();
    await call;
    await pause();

    expect(await agent.oauthKeys("files")).toEqual([]);
  });

  // Same rule. Path: a tool call's refresh waits at the token endpoint; the
  // connection is closed; addMcpServer with { id } migrates the server and
  // gives it a new connection; the refresh returns.
  it("keeps a closed connection's late refresh out of a migrated server's storage", async () => {
    const agent = await newAgent();
    const generated = await connectAuthorized(agent, server);
    server.revokeAccessTokens();
    const release = server.holdRequests("refresh");
    const call = agent.callServerTool(generated, "read");
    await waitingAtServer(server);

    await agent.closeNow(generated);
    await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    await agent.settle();
    const before = await agent.oauthStorage("files");
    release();
    await call;
    await pause();

    expect(await agent.oauthStorage("files")).toEqual(before);
    expect(await agent.oauthKeys(generated)).toEqual([]);
  });
});

describe("an OAuth callback while the connection is closed", () => {
  // McpOAuthCallback.tla, rules SignInSurvivesClose and
  // RemovedMeansRemoved. Path: the user approves; the code exchange waits
  // at the token endpoint; closeConnection drops the connection (the server
  // stays stored); the exchange returns.
  it("keeps the sign-in and does not say the server was removed", async () => {
    const before = await newAgent();
    const added = await before.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (added.state !== "authenticating") throw new Error("expected a link");
    const release = server.holdRequests("token");
    const callback = followCallback(server.authorize(added.authUrl));
    await waitingAtServer(server);

    await before.closeNow("files");
    release();
    const outcome = await callback;
    if (!outcome.authorized) expect(outcome.error).not.toContain("removed");

    // The next wake connects on the grant the user gave, without asking.
    const agent = await restartAgent(before);
    await agent.settle();
    expect(await agent.server("files")).toMatchObject({
      state: "ready",
      auth_url: null
    });
  });

  // Same model, rule StaleCallbackLeavesServerAlone. Path: the server waits
  // on a link; its connection is closed and the server added again, which
  // registers a new client and issues a new link; the user completes the
  // first link.
  it("leaves a server added again alone when the closed connection's link completes", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (first.state !== "authenticating") throw new Error("expected a link");
    await agent.closeNow("files");
    const second = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (second.state !== "authenticating") throw new Error("expected a link");

    await followCallback(server.authorize(first.authUrl));
    await agent.settle();

    expect(await agent.server("files")).toMatchObject({
      state: "authenticating",
      auth_url: second.authUrl,
      error: null
    });
    expect(await followCallback(server.authorize(second.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect((await agent.server("files"))?.state).toBe("ready");
  });
});

describe("a step-up while the server reconnects", () => {
  // McpStepUp.tla, rules SavedLinkIsWaitedOn and ShownReadyHasSession, with
  // a provider whose state check waits on I/O. Path: a tool call hits a
  // step-up and its link is built; authorizationRequired waits on the state
  // check; Reconnect closes the session and connects again; the check
  // returns.
  it("does not save a step-up link for the session the reconnect closed", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    await agent.holdStateCheck();
    const call = agent.callServerTool(id, "write");
    await eventually(async () => (await agent.stateChecksWaiting()) === 1);

    const release = server.holdRequests();
    const reconnecting = agent.reconnect(id);
    await waitingAtServer(server);
    await agent.releaseStateCheck();
    await call;
    release();
    expect(await reconnecting).toMatchObject({ state: "ready" });
    await agent.settle();

    expect(await agent.server(id)).toEqual({
      state: "ready",
      auth_url: null,
      error: null
    });
  });
});

describe("a step-up callback while a token refresh runs", () => {
  // McpAuthorizationTurns.tla, rule StepUpGrantKept. Path: a step-up link is
  // pending; the access token expires and a tool call's refresh waits at
  // the token endpoint; the user completes the step-up; the refresh
  // returns after the exchange.
  it("keeps the step-up grant", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    const asked = await agent.callServerTool(id, "write");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");

    server.revokeAccessTokens();
    const release = server.holdRequests("refresh");
    const call = agent.callServerTool(id, "read");
    await waitingAtServer(server);
    const callback = followCallback(server.authorize(asked.authUrl));
    await pause();
    release();
    expect(await callback).toEqual({ authorized: true });
    await call;
    await agent.settle();

    expect(await agent.callServerTool(id, "write")).toEqual({
      ok: true,
      text: "wrote it"
    });
  });
});

describe("a step-up link after a token refresh", () => {
  // McpAuthorizationTurns.tla, rule PendingLinkCompletes. Path: a step-up
  // link is pending; the access token expires and a tool call refreshes
  // it; the user completes the step-up.
  it("still completes", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    const asked = await agent.callServerTool(id, "write");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");

    server.revokeAccessTokens();
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
    expect(await followCallback(server.authorize(asked.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect(await agent.callServerTool(id, "write")).toEqual({
      ok: true,
      text: "wrote it"
    });
  });
});

describe("a server given a stable id while it waits for the user", () => {
  // McpServerRename.tla, rules HandedLinkReachesServer and
  // SavedLinkReachesServer. Path: the server waits on a link under its
  // generated id; addMcpServer with { id } migrates it and hands back the
  // link it waits on; the user opens that link.
  it("hands back a link whose callback reaches the server", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (first.state !== "authenticating") throw new Error("expected a link");

    const again = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (again.state !== "authenticating") throw new Error("expected a link");
    expect(await agent.server("files")).toMatchObject({
      state: "authenticating",
      auth_url: again.authUrl
    });

    expect(await followCallback(server.authorize(again.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect((await agent.server("files"))?.state).toBe("ready");
  });

  // Same rules, rule NothingLeftUnderOldId. Path: a step-up is pending on
  // the live session under the generated id; the server is migrated.
  it("keeps the session working and asks again under the new id after a pending step-up", async () => {
    const agent = await newAgent();
    const generated = await connectAuthorized(agent, server, {
      scope: READ_SCOPE
    });
    const asked = await agent.callServerTool(generated, "write");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");

    expect(
      await agent.connectServer(MCP_URL, {
        callbackHost: CLIENT_ORIGIN,
        id: "files"
      })
    ).toEqual({ id: "files", state: "ready" });
    expect(await agent.callServerTool("files", "read")).toEqual({
      ok: true,
      text: "read it"
    });

    const again = await agent.callServerTool("files", "write");
    if (again.ok || !again.authUrl) throw new Error("expected a link");
    expect(await followCallback(server.authorize(again.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect(await agent.callServerTool("files", "write")).toEqual({
      ok: true,
      text: "wrote it"
    });
  });
});

describe("elicitation handlers configured while a server connects", () => {
  // McpElicitationHandlers.tla, rule ConfigureNeverFailsServer. Path: the
  // wake's restore connects; the app configures its handlers, as onStart
  // does, while the handshake is in flight; the handshake returns.
  it("keeps the server's connection working", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);
    const release = server.holdRequests();
    const agent = await restartAgent(before);
    await waitingAtServer(server);

    await agent.configureElicitation();
    release();
    await agent.settle();

    expect((await agent.server(id))?.state).toBe("ready");
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });

  // Same model, rule ConnectedAdvertisesHandlers. Path: as above, on the
  // first wake after the app started configuring handlers, so the row
  // carries no stamp and the handshake in flight advertises nothing.
  it("advertises them once the server is connected", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);
    const release = server.holdRequests();
    const agent = await restartAgent(before);
    await waitingAtServer(server);

    await agent.configureElicitation();
    release();
    await agent.settle();

    expect((await agent.server(id))?.state).toBe("ready");
    expect(await agent.advertisedElicitation(id)).toEqual({ form: {} });
  });
});

describe("step-up rounds for two scope sets", () => {
  // McpAuthorizationRounds.tla, rules ExhaustedOnlyAfterLimit and
  // CompletionIsOwn. Path: a step-up link for one scope set is pending; the
  // server asks for another scope set, whose link becomes the latest; the
  // user completes the first link. After three such authorizations the
  // second scope set must not have used up its budget: nobody completed a
  // link of its own.
  it("counts a completed authorization for the scope set of its own link", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });

    // The authorization server grants the write scope only the third time.
    for (const grant of [
      { scope: READ_SCOPE },
      { scope: READ_SCOPE },
      undefined
    ]) {
      const write = await agent.callServerTool(id, "write");
      const admin = await agent.callServerTool(id, "admin");
      if (write.ok || !write.authUrl) throw new Error("expected a link");
      expect(admin).toMatchObject({ authorizationRequired: true });
      expect(
        await followCallback(server.authorize(write.authUrl, grant))
      ).toEqual({ authorized: true });
      await agent.settle();
    }
    expect(await agent.callServerTool(id, "write")).toMatchObject({ ok: true });

    // The admin scope was asked for three times and never authorized.
    expect(await agent.callServerTool(id, "admin")).toMatchObject({
      authorizationRequired: true
    });
    expect((await agent.server(id))?.state).toBe("authenticating");
  });
});

describe("a sign-in asked for mid-session", () => {
  // McpStepUp.tla, rule ReadyHoldsGrant. Path: the token expires and the
  // refresh is refused, so the tokens are dropped and a tool call is
  // answered with a sign-in link; the user declines it.
  it("is recorded as declined, not shown ready without a grant", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);
    server.revokeAccessTokens();
    server.options.refuseRefresh = true;
    const asked = await agent.callServerTool(id, "read");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");

    // Nothing works until the user signs in: requests get the same link.
    expect(await agent.callServerTool(id, "read")).toMatchObject({
      authorizationRequired: true,
      authUrl: asked.authUrl
    });

    expect(await followCallback(server.deny(asked.authUrl))).toEqual({
      authorized: false,
      error: "access_denied"
    });
    await agent.settle();
    expect(await agent.server(id)).toMatchObject({
      state: "failed",
      auth_url: null,
      error: "access_denied"
    });
  });

  // Same path, approved: the server is ready on the new grant.
  it("connects again once the user signs in", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);
    server.revokeAccessTokens();
    server.options.refuseRefresh = true;
    const asked = await agent.callServerTool(id, "read");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");

    expect(await followCallback(server.authorize(asked.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });
});
