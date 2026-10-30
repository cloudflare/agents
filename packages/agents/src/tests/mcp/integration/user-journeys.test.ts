import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  followCallback,
  newAgent,
  restartAgent,
  useOAuthMcpServer
} from "./harness";
import { CLIENT_ORIGIN, MCP_URL, READ_SCOPE } from "./oauth-mcp-server";

const server = useOAuthMcpServer();

/**
 * What people and apps do that the happy path does not: click things twice,
 * click old links, press Reconnect at odd times, and keep going while a
 * server is down. Each case shows where the agent ends up and that it can
 * carry on from there.
 */

describe("A user clicking authorization links", () => {
  it("can still complete an older link after pressing Reconnect", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (first.state !== "authenticating") throw new Error("expected a link");
    const second = await agent.reconnect(first.id);
    if (second.state !== "authenticating") throw new Error("expected a link");
    expect(second.authUrl).not.toBe(first.authUrl);

    // The user finds the first tab and completes it: the agent issued that
    // link, so it is honoured.
    expect(await followCallback(server.authorize(first.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect(await agent.callServerTool(first.id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });

  it("changes nothing when a used callback is opened again", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");
    const callback = server.authorize(added.authUrl);
    await followCallback(callback);
    await agent.settle();
    const exchanges = server.codeExchanges();

    // Browser history, a refresh, or a second tab.
    expect(await followCallback(callback)).toEqual({ authorized: true });
    await agent.settle();
    expect(server.codeExchanges()).toBe(exchanges);
    expect((await agent.server(added.id))?.state).toBe("ready");
  });

  it("keeps the tools it has while a step-up waits, and completes the latest link", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });

    const first = await agent.callServerTool(id, "write");
    const second = await agent.callServerTool(id, "write");
    expect(first).toMatchObject({ authorizationRequired: true });
    expect(second).toMatchObject({ authorizationRequired: true });
    // Tools the grant already covers keep working meanwhile.
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });

    if (second.ok || !second.authUrl) throw new Error("expected a link");
    expect((await agent.server(id))?.auth_url).toBe(second.authUrl);
    await followCallback(server.authorize(second.authUrl));
    await agent.settle();
    expect(await agent.callServerTool(id, "write")).toMatchObject({
      ok: true
    });
  });
});

describe("A user who does not authorize", () => {
  it("keeps the session on its current grant after declining a step-up, and is asked again on the next request that needs it", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    const asked = await agent.callServerTool(id, "write");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");

    expect(await followCallback(server.deny(asked.authUrl))).toEqual({
      authorized: false,
      error: "access_denied"
    });
    await agent.settle();
    expect(await agent.server(id)).toEqual({
      state: "ready",
      auth_url: null,
      error: null
    });
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });

    const again = await agent.callServerTool(id, "write");
    expect(again).toMatchObject({ authorizationRequired: true });
    if (again.ok || !again.authUrl) throw new Error("expected a link");
    await followCallback(server.authorize(again.authUrl));
    await agent.settle();
    expect(await agent.callServerTool(id, "write")).toMatchObject({
      ok: true
    });
  });

  it("reconnects on its current grant when a step-up is declined after the agent woke", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server, { scope: READ_SCOPE });
    const asked = await before.callServerTool(id, "write");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");
    const agent = await restartAgent(before);

    await followCallback(server.deny(asked.authUrl));
    await agent.settle();
    expect(await agent.server(id)).toMatchObject({
      state: "ready",
      auth_url: null
    });
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });

  it("records a declined sign-in as declined after a wake, even when old tokens are still stored", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);
    // The token expired and the refresh is refused, so the wake asks the
    // user to sign in again: a fresh authorization, not a step-up.
    server.revokeAccessTokens();
    server.options.refuseRefresh = true;
    const agent = await restartAgent(before);
    await agent.settle();
    const asked = await agent.server(id);
    if (asked?.state !== "authenticating" || !asked.auth_url) {
      throw new Error(`expected a link, got ${asked?.state}`);
    }

    await followCallback(server.deny(asked.auth_url));
    await agent.settle();
    expect(await agent.server(id)).toMatchObject({
      state: "failed",
      auth_url: null,
      error: "access_denied"
    });
  });

  it("answers a request made before the first authorization with the link the server waits on", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");

    expect(await agent.callServerTool(added.id, "read")).toMatchObject({
      ok: false,
      authorizationRequired: true,
      authUrl: added.authUrl
    });
    expect((await agent.server(added.id))?.auth_url).toBe(added.authUrl);
  });

  it("explains how to let the user authorize when no callback is configured", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {});
    expect(added.state).toBe("error");
    if (added.state !== "error") throw new Error("unreachable");
    expect(added.message).toContain("requires authorization");
    expect(added.message).toContain("callbackHost");
  });
});

describe("A user pressing Reconnect", () => {
  it("reconnects a ready server and keeps it ready", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);
    expect(await agent.reconnect(id)).toEqual({ id, state: "ready" });
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });

  it("ends with one working connection when pressed twice at once", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);
    const [a, b] = await Promise.all([
      agent.reconnect(id),
      agent.reconnect(id)
    ]);
    expect(a).toEqual({ id, state: "ready" });
    expect(b).toEqual({ id, state: "ready" });
    expect(await agent.serverIds()).toEqual([id]);
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });

  it("says so when the server is not registered", async () => {
    const agent = await newAgent();
    expect(await agent.reconnect("missing")).toEqual({
      state: "error",
      message: 'MCP server "missing" is not registered'
    });
  });
});

describe("An MCP server that misbehaves", () => {
  it("fails a request while it is down, keeps the server ready, and serves the next request once it is back", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);

    server.options.up = false;
    const down = await agent.callServerTool(id, "read");
    expect(down).toMatchObject({ ok: false, authorizationRequired: false });
    expect(await agent.server(id)).toMatchObject({
      state: "ready",
      auth_url: null
    });

    server.options.up = true;
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
  });

  it("recovers within the quick attempts from one failed handshake", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, undefined, {
      maxAttempts: 3
    });
    server.options.failNext = server.options.legacyOnly
      ? "initialize"
      : "server/discover";
    expect(await agent.reconnect(id)).toEqual({ id, state: "ready" });
    expect(server.options.failNext).toBeUndefined();
  });
});
