import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MessageType } from "../../../types";
import {
  agentName,
  connectAuthorized,
  eventually,
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
  NOTES_URI,
  READ_SCOPE,
  SECRET_URI,
  WRITE_SCOPE
} from "./oauth-mcp-server";

const server = useOAuthMcpServer();

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

// Each flow runs against a current server and against one that only speaks
// the 2025-11-25 protocol, so the client takes its fallback path.
describe.each([
  { protocol: "2026-07-28", legacyOnly: false },
  { protocol: "2025-11-25", legacyOnly: true }
])("over the $protocol protocol", ({ legacyOnly }) => {
  beforeEach(() => {
    server.options.legacyOnly = legacyOnly;
  });

  describe("MCP re-authorization in an Agent", () => {
    it("connects through OAuth and calls a tool", async () => {
      const agent = await newAgent();
      const id = await connectAuthorized(agent, server);

      // The client took the path this protocol needs.
      expect(server.mcpMethods.includes("initialize")).toBe(legacyOnly);

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
      // The catalog requests that got a 401 together shared one flow.
      expect(server.registeredClients).toHaveLength(1);
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

    it("refreshes once for two calls whose token expired together", async () => {
      const agent = await newAgent();
      const id = await connectAuthorized(agent, server);

      server.revokeAccessTokens();
      const [first, second] = await Promise.all([
        agent.callServerTool(id, "read"),
        agent.callServerTool(id, "read")
      ]);

      expect(first).toEqual({ ok: true, text: "read it" });
      expect(second).toEqual({ ok: true, text: "read it" });
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
});

describe("MCP requests that surface re-authorization", () => {
  it("surfaces a step-up from readResource and getPrompt", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });

    expect(await agent.readServerResource(id, NOTES_URI)).toEqual({
      ok: true,
      text: "some notes"
    });
    const resource = await agent.readServerResource(id, SECRET_URI);
    expect(resource).toMatchObject({ ok: false, authorizationRequired: true });

    const prompt = await agent.getServerPrompt(id, "draft");
    expect(prompt).toMatchObject({ ok: false, authorizationRequired: true });

    const { auth_url } = (await agent.server(id)) ?? {};
    if (!auth_url) throw new Error("expected a link");
    await followCallback(server.authorize(auth_url));
    await agent.settle();
    expect(await agent.readServerResource(id, SECRET_URI)).toEqual({
      ok: true,
      text: "the secret"
    });
    expect(await agent.getServerPrompt(id, "draft")).toEqual({
      ok: true,
      text: "a draft"
    });
  });

  it("surfaces a step-up from an AI SDK tool's execute", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });

    expect(await agent.executeAITool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
    const denied = await agent.executeAITool(id, "write");
    expect(denied).toMatchObject({ ok: false, authorizationRequired: true });
    if (denied.ok || !denied.authUrl) throw new Error("expected a link");

    await followCallback(server.authorize(denied.authUrl));
    await agent.settle();
    expect(await agent.executeAITool(id, "write")).toEqual({
      ok: true,
      text: "wrote it"
    });
  });

  it("rejects requests for a server it has no connection to", async () => {
    const agent = await newAgent();
    for (const outcome of [
      await agent.callServerTool("missing", "read"),
      await agent.readServerResource("missing", NOTES_URI),
      await agent.getServerPrompt("missing", "draft")
    ]) {
      expect(outcome).toMatchObject({
        ok: false,
        name: "MCPConnectionNotFoundError"
      });
    }
  });
});

type ServersMessage = {
  type: string;
  mcp?: {
    servers: Record<string, { state: string; auth_url: string | null }>;
  };
};

/** Open a browser's WebSocket to the agent and collect what it is sent. */
async function openClient(name: string) {
  const response = await exports.default.fetch(
    `${CLIENT_ORIGIN}/agents/mcp-integration-agent/${name}`,
    { headers: { Upgrade: "websocket" } }
  );
  const ws = response.webSocket;
  if (!ws) throw new Error(`No WebSocket: ${response.status}`);
  ws.accept();
  const messages: ServersMessage[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string) as ServersMessage);
  });
  return {
    ws,
    /** The latest server list the browser was sent. */
    latestServers() {
      const last = messages
        .filter((message) => message.type === MessageType.CF_AGENT_MCP_SERVERS)
        .at(-1);
      return last?.mcp?.servers ?? {};
    }
  };
}

describe("What a connected browser sees", () => {
  it("is sent the authorization link when a step-up starts, and the ready server when it ends", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    const client = await openClient(agentName(agent));
    await eventually(async () => client.latestServers()[id]?.state === "ready");

    const denied = await agent.callServerTool(id, "write");
    if (denied.ok || !denied.authUrl) throw new Error("expected a link");
    await eventually(
      async () => client.latestServers()[id]?.auth_url === denied.authUrl
    );
    expect(client.latestServers()[id]?.state).toBe("authenticating");

    await followCallback(server.authorize(denied.authUrl));
    await agent.settle();
    await eventually(
      async () =>
        client.latestServers()[id]?.state === "ready" &&
        client.latestServers()[id]?.auth_url === null
    );
    client.ws.close();
  });
});

describe("MCP OAuth callbacks in an Agent", () => {
  it("reuses saved tokens after a wake without asking the user", async () => {
    const before = await newAgent();
    const id = await connectAuthorized(before, server);

    const agent = await restartAgent(before);
    await agent.settle();
    expect((await agent.server(id))?.state).toBe("ready");
    expect(await agent.callServerTool(id, "read")).toMatchObject({ ok: true });
    expect(server.codeExchanges()).toBe(1);
  });

  it("reports a denied authorization and offers a new link when the server is added again", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");

    expect(await followCallback(server.deny(added.authUrl))).toMatchObject({
      authorized: false
    });
    await agent.settle();
    expect(server.codeExchanges()).toBe(0);
    expect((await agent.server(added.id))?.state).not.toBe("ready");

    const again = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    expect(again.state).toBe("authenticating");
    if (again.state !== "authenticating") throw new Error("unreachable");
    expect(await followCallback(server.authorize(again.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect((await agent.server(added.id))?.state).toBe("ready");
  });

  it("refuses a callback whose state it did not issue", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN
    });
    if (added.state !== "authenticating") throw new Error("expected a link");

    const forged = new URL(server.authorize(added.authUrl));
    forged.searchParams.set("state", `forged.${added.id}`);
    expect(await followCallback(forged.toString())).toMatchObject({
      authorized: false
    });
    await agent.settle();
    expect(server.codeExchanges()).toBe(0);
    expect(await agent.server(added.id)).toMatchObject({
      state: "authenticating",
      auth_url: added.authUrl
    });
  });

  it("forgets step-up rounds an hour after the last one", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    await completeUnsatisfiedRounds(agent, id, "write");

    await agent.ageAuthorizationRounds(id, 60 * 60 * 1000 + 1);
    expect(await agent.callServerTool(id, "write")).toMatchObject({
      authorizationRequired: true
    });
  });
});
