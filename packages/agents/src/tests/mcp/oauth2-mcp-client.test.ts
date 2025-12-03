import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../worker";
import { nanoid } from "nanoid";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("OAuth2 MCP Client - Hibernation", () => {
  it("should restore MCP connections from database on wake-up", async () => {
    const agentId = env.TestOAuthAgent.idFromName("test-oauth-hibernation");
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const authUrl = "http://example.com/oauth/authorize";
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    // Ensure storage table exists
    agentStub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;

    // Insert persisted MCP server (simulating pre-hibernation state)
    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test-oauth-server"}, ${"http://example.com/mcp"}, ${"test-client-id"}, ${authUrl}, ${fullCallbackUrl}, ${null})
    `;

    // Simulate DO wake-up
    await agentStub.setName("default");
    await agentStub.onStart();

    // Verify connection restored with authenticating state
    expect(await agentStub.hasMcpConnection(serverId)).toBe(true);
  });

  it("should handle OAuth callback after hibernation", async () => {
    const agentId = env.TestOAuthAgent.idFromName("test-oauth-callback");
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    // Ensure storage table exists
    agentStub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${fullCallbackUrl}, ${null})
    `;

    await agentStub.setName("default");
    await agentStub.onStart();

    const response = await agentStub.fetch(
      new Request(`${fullCallbackUrl}?code=test-code&state=test-state`)
    );

    expect(response.status).not.toBe(404);
    expect(await response.text()).not.toContain("Could not find serverId");
  });
});

describe("OAuth2 MCP Client - Callback Handling", () => {
  it("should process OAuth callback with valid connection", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client-id"}, ${"http://example.com/auth"}, ${fullCallbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackBaseUrl,
      "client-id"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    const response = await agentStub.fetch(
      new Request(`${fullCallbackUrl}?code=test-code&state=test-state`)
    );

    expect(response.status).toBe(200);
  });

  it("should clear auth_url after successful OAuth", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const authUrl = "http://example.com/oauth/authorize";
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client-id"}, ${authUrl}, ${fullCallbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackBaseUrl,
      "client-id"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    await agentStub.fetch(
      new Request(`${fullCallbackUrl}?code=test-code&state=test-state`)
    );

    const serverAfter = await agentStub.getMcpServerFromDb(serverId);
    expect(serverAfter?.auth_url).toBeNull();
  });
});

describe("OAuth2 MCP Client - Error Handling", () => {
  it("should reject callback without code parameter", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${fullCallbackUrl}, ${null})
    `;

    const response = await agentStub.fetch(
      new Request(`${fullCallbackUrl}?state=test-state`)
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("should reject callback without state parameter", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${fullCallbackUrl}, ${null})
    `;

    const response = await agentStub.fetch(
      new Request(`${fullCallbackUrl}?code=test-code`)
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("OAuth2 MCP Client - Redirect Behavior", () => {
  it("should redirect to success URL after OAuth", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackBaseUrl = `http://example.com/agents/oauth/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    await agentStub.setName("default");
    await agentStub.onStart();
    await agentStub.configureOAuthForTest({ successRedirect: "/dashboard" });

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${fullCallbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackBaseUrl,
      "client"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    const response = await agentStub.fetch(
      new Request(`${fullCallbackUrl}?code=test-code&state=test-state`, {
        redirect: "manual"
      })
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "http://example.com/dashboard"
    );
  });

  it("should redirect to error URL on OAuth failure", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackBaseUrl = `http://example.com/agents/oauth/${agentId.toString()}/callback`;
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;

    await agentStub.setName("default");
    await agentStub.onStart();
    await agentStub.configureOAuthForTest({ errorRedirect: "/error" });

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${fullCallbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackBaseUrl,
      "client"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    const response = await agentStub.fetch(
      new Request(`${fullCallbackUrl}?error=access_denied&state=test-state`, {
        redirect: "manual"
      })
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(
      /^http:\/\/example\.com\/error\?error=/
    );
  });
});

describe("OAuth2 MCP Client - Basic Functionality", () => {
  it("should handle non-callback requests normally", async () => {
    const ctx = createExecutionContext();
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    await agentStub.setName("default");
    await agentStub.onStart();

    const response = await worker.fetch(
      new Request(
        `http://example.com/agents/test-o-auth-agent/${agentId.toString()}`
      ),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Test OAuth Agent");
  });
});

describe("OAuth2 MCP Client - Multiple Servers", () => {
  it("should route callbacks to correct server when multiple OAuth servers share same base callback URL", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const serverIdA = nanoid(8);
    const serverIdB = nanoid(8);
    const fullCallbackUrlA = `${callbackBaseUrl}/${serverIdA}`;
    const fullCallbackUrlB = `${callbackBaseUrl}/${serverIdB}`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdA}, ${"server-a"}, ${"http://server-a.com/mcp"}, ${"client-a"}, ${"http://server-a.com/auth"}, ${callbackBaseUrl}, ${null})
    `;

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdB}, ${"server-b"}, ${"http://server-b.com/mcp"}, ${"client-b"}, ${"http://server-b.com/auth"}, ${callbackBaseUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverIdA,
      "server-a",
      "http://server-a.com/mcp",
      callbackBaseUrl,
      "client-a"
    );
    await agentStub.setupMockOAuthState(serverIdA, "code-a", "state-a");

    await agentStub.setupMockMcpConnection(
      serverIdB,
      "server-b",
      "http://server-b.com/mcp",
      callbackBaseUrl,
      "client-b"
    );
    await agentStub.setupMockOAuthState(serverIdB, "code-b", "state-b");

    const responseB = await agentStub.fetch(
      new Request(`${fullCallbackUrlB}?code=code-b&state=state-b`)
    );

    expect(responseB.status).toBe(200);

    const serverBAfter = await agentStub.getMcpServerFromDb(serverIdB);
    expect(serverBAfter?.auth_url).toBeNull();

    const responseA = await agentStub.fetch(
      new Request(`${fullCallbackUrlA}?code=code-a&state=state-a`)
    );

    expect(responseA.status).toBe(200);

    const serverAAfter = await agentStub.getMcpServerFromDb(serverIdA);
    expect(serverAAfter?.auth_url).toBeNull();
  });

  it("should correctly identify callback requests by serverId in URL path", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const serverIdA = nanoid(8);
    const nonExistentServerId = nanoid(8);

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdA}, ${"server-a"}, ${"http://server-a.com/mcp"}, ${"client-a"}, ${"http://server-a.com/auth"}, ${callbackBaseUrl}, ${null})
    `;

    const isCallbackA = await agentStub.testIsCallbackRequest(
      new Request(`${callbackBaseUrl}/${serverIdA}?code=test&state=test`)
    );
    expect(isCallbackA).toBe(true);

    const isCallbackNonExistent = await agentStub.testIsCallbackRequest(
      new Request(
        `${callbackBaseUrl}/${nonExistentServerId}?code=test&state=test`
      )
    );
    expect(isCallbackNonExistent).toBe(false);

    const isCallbackNoServerId = await agentStub.testIsCallbackRequest(
      new Request(`${callbackBaseUrl}?code=test&state=test`)
    );
    expect(isCallbackNoServerId).toBe(false);
  });
});
