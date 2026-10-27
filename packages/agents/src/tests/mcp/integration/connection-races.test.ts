import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  followCallback,
  newAgent,
  restartAgent,
  useOAuthMcpServer
} from "./harness";
import { CLIENT_ORIGIN, MCP_URL } from "./oauth-mcp-server";

const server = useOAuthMcpServer();

describe("MCP connection work in an Agent", () => {
  it("leaves nothing behind when a server is removed while it is reconnecting", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);

    // The wake's restore starts connecting and waits on the server.
    const release = server.holdRequests();
    const agent = await restartAgent(before);
    expect((await agent.server(id))?.state).not.toBe("ready");

    await agent.remove(id);
    release();
    await agent.settle();

    expect(await agent.serverIds()).toEqual([]);
    expect(await agent.toolNames()).toEqual([]);
    expect(await agent.mcpJobs()).toEqual([]);
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    await agent.remove("files");
    const second = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    if (second.state !== "authenticating") throw new Error("expected a link");

    release();
    await callback;
    await agent.settle();

    expect(await agent.server("files")).toMatchObject({
      state: "authenticating",
      auth_url: second.authUrl
    });
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

    for (const response of responses) {
      expect(response.status).toBeLessThan(500);
    }
    const exchanges = server.tokenRequests.filter(
      (params) => params.get("grant_type") === "authorization_code"
    );
    expect(exchanges).toHaveLength(1);
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
});
