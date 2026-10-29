import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  followCallback,
  newAgent,
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
