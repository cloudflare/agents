import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  eventually,
  followCallback,
  newAgent,
  pause,
  restartAgent,
  waitingAtServer,
  useOAuthMcpServers
} from "./harness";
import { CLIENT_ORIGIN, MCP_URL, READ_SCOPE } from "./oauth-mcp-server";

const [server, other] = useOAuthMcpServers({
  origin: "https://other-mcp.integration.example",
  authOrigin: "https://other-auth.integration.example"
});

describe("MCP connection work in an Agent", () => {
  it("leaves nothing behind when a server is removed while it is reconnecting", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);

    // The wake's restore starts connecting and waits on the server.
    const release = server.holdRequests();
    const agent = await restartAgent(before);
    await waitingAtServer(server);
    expect((await agent.server(id))?.state).not.toBe("ready");

    await agent.remove(id);
    release();
    await agent.settle();

    expect(await agent.serverIds()).toEqual([]);
    expect(await agent.toolNames()).toEqual([]);
    expect(await agent.mcpJobs()).toEqual([]);
  });

  it("cancels an add queued behind the wake's restore when the server is removed", async () => {
    const before = await newAgent();
    await connectAuthorized(before, server, undefined, { id: "files" });

    const release = server.holdRequests();
    const agent = await restartAgent(before);
    await waitingAtServer(server);
    const added = agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    // The add queues behind the restore; nothing outside shows it queued.
    await pause();
    await agent.remove("files");
    release();

    const outcome = await added;
    expect(outcome.state).toBe("error");
    if (outcome.state !== "error") throw new Error("unreachable");
    expect(outcome.message).toContain("removed");
    await agent.settle();
    expect(await agent.serverIds()).toEqual([]);
  });

  it("answers a callback queued behind a connect when the server is removed", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    const denied = await agent.callServerTool(id, "write");
    if (denied.ok || !denied.authUrl) throw new Error("expected a link");

    // A connect holds the server's queue; the user's callback waits behind it.
    const release = server.holdRequests();
    const connecting = agent.connectNow(id);
    await waitingAtServer(server);
    const callback = followCallback(server.authorize(denied.authUrl));
    // The callback queues behind the connect; nothing outside shows it queued.
    await pause();
    await agent.remove(id);
    release();

    const outcome = await callback;
    expect(outcome).toMatchObject({ authorized: false });
    if (outcome.authorized) throw new Error("unreachable");
    expect(outcome.error).toContain("removed");
    await connecting;
    await agent.settle();
    expect(await agent.serverIds()).toEqual([]);
    // Only the first authorization's code was ever exchanged.
    expect(server.codeExchanges()).toBe(1);
  });

  it("leaves a server re-added under the same id alone when the old code exchange finishes late", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (first.state !== "authenticating") throw new Error("expected a link");

    // The user approves; the code exchange waits on the token endpoint.
    const release = server.holdRequests("token");
    const callback = followCallback(server.authorize(first.authUrl));
    await waitingAtServer(server);

    await agent.remove("files");
    const second = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (second.state !== "authenticating") throw new Error("expected a link");

    release();
    expect(await callback).toMatchObject({ authorized: false });
    await agent.settle();

    expect(await agent.server("files")).toMatchObject({
      state: "authenticating",
      auth_url: second.authUrl
    });
  });

  it("leaves a server re-added under the same id alone when the old code exchange fails late", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (first.state !== "authenticating") throw new Error("expected a link");

    const release = server.holdRequests("token");
    const callback = followCallback(server.authorize(first.authUrl));
    await waitingAtServer(server);
    await agent.remove("files");
    const second = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (second.state !== "authenticating") throw new Error("expected a link");

    server.options.refuseCodes = true;
    release();
    expect(await callback).toMatchObject({ authorized: false });
    await agent.settle();

    expect(await agent.server("files")).toMatchObject({
      state: "authenticating",
      auth_url: second.authUrl,
      error: null
    });
  });

  it("does not keep the tokens a callback saved after its server was removed", async () => {
    const agent = await newAgent();
    const first = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (first.state !== "authenticating") throw new Error("expected a link");

    const release = server.holdRequests("token");
    const callback = followCallback(server.authorize(first.authUrl));
    await waitingAtServer(server);
    await agent.remove("files");
    release();
    expect(await callback).toMatchObject({ authorized: false });
    await agent.settle();

    // Added again, the server has no grant and must ask the user.
    const again = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    expect(again.state).toBe("authenticating");
  });

  it("exchanges the code once when two callbacks for one link arrive together", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");

    const responses = await Promise.all([
      followCallback(server.authorize(added.authUrl)),
      followCallback(server.authorize(added.authUrl))
    ]);
    await agent.settle();

    // The first redeems the code; the second finds the flow already done.
    expect(responses).toEqual([{ authorized: true }, { authorized: true }]);
    expect(server.codeExchanges()).toBe(1);
    expect((await agent.server(added.id))?.state).toBe("ready");
  });

  it("keeps one connection when tool calls and a reconnect overlap", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server);

    const [added, first, second] = await Promise.all([
      agent.connectServer(MCP_URL, { callbackHost: CLIENT_ORIGIN }),
      agent.callServerTool(id, "read"),
      agent.callServerTool(id, "read")
    ]);

    expect(added).toMatchObject({ id, state: "ready" });
    expect(first).toEqual({ ok: true, text: "read it" });
    expect(second).toEqual({ ok: true, text: "read it" });
    expect(await agent.serverIds()).toEqual([id]);
  });

  it("serves one server while another is still reconnecting", async () => {
    const before = await newAgent();
    const slow = await connectAuthorized(before, server, undefined, {
      id: "slow"
    });
    const fast = await connectAuthorized(before, other, undefined, {
      id: "fast",
      name: "other"
    });

    const release = server.holdRequests();
    const agent = await restartAgent(before);
    await eventually(async () => (await agent.server(fast))?.state === "ready");
    expect((await agent.server(slow))?.state).not.toBe("ready");
    expect(await agent.callServerTool(fast, "read")).toEqual({
      ok: true,
      text: "read it"
    });

    release();
    await agent.settle();
    expect((await agent.server(slow))?.state).toBe("ready");
  });
});
