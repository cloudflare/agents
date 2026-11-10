import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
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
