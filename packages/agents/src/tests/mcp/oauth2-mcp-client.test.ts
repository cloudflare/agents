import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env, TestOAuthAgent } from "../worker";
import { nanoid } from "nanoid";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function createStateWithSetup(
  agentStub: DurableObjectStub<TestOAuthAgent>,
  serverId: string
): string {
  const nonce = nanoid();
  agentStub.saveStateForTest(nonce, serverId);
  return `${nonce}.${serverId}`;
}

describe("OAuth2 MCP Client - Hibernation", () => {
  it("should restore MCP connections from database on wake-up", async () => {
    const agentId = env.TestOAuthAgent.idFromName("test-oauth-hibernation");
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const authUrl = "http://example.com/oauth/authorize";
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

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
      VALUES (${serverId}, ${"test-oauth-server"}, ${"http://example.com/mcp"}, ${"test-client-id"}, ${authUrl}, ${callbackUrl}, ${null})
    `;

    await agentStub.setName("default");
    await agentStub.onStart();

    expect(await agentStub.hasMcpConnection(serverId)).toBe(true);
  });

  it("should handle OAuth callback after hibernation", async () => {
    const agentId = env.TestOAuthAgent.idFromName("test-oauth-callback");
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

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
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setName("default");
    await agentStub.onStart();

    const response = await agentStub.fetch(
      new Request(
        `${callbackUrl}?code=test-code&state=${createStateWithSetup(agentStub, serverId)}`
      )
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
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client-id"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackUrl,
      "client-id"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    const response = await agentStub.fetch(
      new Request(
        `${callbackUrl}?code=test-code&state=${createStateWithSetup(agentStub, serverId)}`
      )
    );

    expect(response.status).toBe(200);
  });

  it("should clear auth_url after successful OAuth", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const authUrl = "http://example.com/oauth/authorize";
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client-id"}, ${authUrl}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackUrl,
      "client-id"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    await agentStub.fetch(
      new Request(
        `${callbackUrl}?code=test-code&state=${createStateWithSetup(agentStub, serverId)}`
      )
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
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    const response = await agentStub.fetch(
      new Request(
        `${callbackUrl}?state=${createStateWithSetup(agentStub, serverId)}`
      )
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("should not recognize callback without state parameter", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    const isCallback = await agentStub.testIsCallbackRequest(
      new Request(`${callbackUrl}?code=test-code`)
    );
    expect(isCallback).toBe(false);
  });
});

describe("OAuth2 MCP Client - Redirect Behavior", () => {
  it("should redirect to success URL after OAuth", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackUrl = `http://example.com/agents/oauth/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();
    await agentStub.configureOAuthForTest({ successRedirect: "/dashboard" });

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackUrl,
      "client"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    const response = await agentStub.fetch(
      new Request(
        `${callbackUrl}?code=test-code&state=${createStateWithSetup(agentStub, serverId)}`,
        {
          redirect: "manual"
        }
      )
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
    const callbackUrl = `http://example.com/agents/oauth/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();
    await agentStub.configureOAuthForTest({ errorRedirect: "/error" });

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackUrl,
      "client"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    const response = await agentStub.fetch(
      new Request(
        `${callbackUrl}?error=access_denied&state=${createStateWithSetup(agentStub, serverId)}`,
        { redirect: "manual" }
      )
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
  it("should route callbacks to correct server via state parameter", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const serverIdA = nanoid(8);
    const serverIdB = nanoid(8);

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdA}, ${"server-a"}, ${"http://server-a.com/mcp"}, ${"client-a"}, ${"http://server-a.com/auth"}, ${callbackUrl}, ${null})
    `;

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdB}, ${"server-b"}, ${"http://server-b.com/mcp"}, ${"client-b"}, ${"http://server-b.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverIdA,
      "server-a",
      "http://server-a.com/mcp",
      callbackUrl,
      "client-a"
    );
    await agentStub.setupMockOAuthState(serverIdA, "code-a", "state-a");

    await agentStub.setupMockMcpConnection(
      serverIdB,
      "server-b",
      "http://server-b.com/mcp",
      callbackUrl,
      "client-b"
    );
    await agentStub.setupMockOAuthState(serverIdB, "code-b", "state-b");

    const responseB = await agentStub.fetch(
      new Request(
        `${callbackUrl}?code=code-b&state=${createStateWithSetup(agentStub, serverIdB)}`
      )
    );

    expect(responseB.status).toBe(200);

    const serverBAfter = await agentStub.getMcpServerFromDb(serverIdB);
    expect(serverBAfter?.auth_url).toBeNull();

    const responseA = await agentStub.fetch(
      new Request(
        `${callbackUrl}?code=code-a&state=${createStateWithSetup(agentStub, serverIdA)}`
      )
    );

    expect(responseA.status).toBe(200);

    const serverAAfter = await agentStub.getMcpServerFromDb(serverIdA);
    expect(serverAAfter?.auth_url).toBeNull();
  });

  it("should correctly identify callback requests by serverId in state", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;
    const serverIdA = nanoid(8);
    const nonExistentServerId = nanoid(8);

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdA}, ${"server-a"}, ${"http://server-a.com/mcp"}, ${"client-a"}, ${"http://server-a.com/auth"}, ${callbackUrl}, ${null})
    `;

    const isCallbackA = await agentStub.testIsCallbackRequest(
      new Request(
        `${callbackUrl}?code=test&state=${createStateWithSetup(agentStub, serverIdA)}`
      )
    );
    expect(isCallbackA).toBe(true);

    const isCallbackNonExistent = await agentStub.testIsCallbackRequest(
      new Request(
        `${callbackUrl}?code=test&state=${nanoid()}.${nonExistentServerId}`
      )
    );
    expect(isCallbackNonExistent).toBe(false);

    const isCallbackNoState = await agentStub.testIsCallbackRequest(
      new Request(`${callbackUrl}?code=test`)
    );
    expect(isCallbackNoState).toBe(false);

    const isCallbackInvalidState = await agentStub.testIsCallbackRequest(
      new Request(`${callbackUrl}?code=test&state=invalid-no-dot`)
    );
    expect(isCallbackInvalidState).toBe(false);
  });
});

describe("OAuth2 MCP Client - State Security", () => {
  it("should reject reused state (single-use enforcement)", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client-id"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackUrl,
      "client-id"
    );
    await agentStub.setupMockOAuthState(serverId, "test-code", "test-state");

    const state = createStateWithSetup(agentStub, serverId);

    const response1 = await agentStub.fetch(
      new Request(`${callbackUrl}?code=test-code&state=${state}`)
    );
    expect(response1.status).toBe(200);

    const response2 = await agentStub.fetch(
      new Request(`${callbackUrl}?code=test-code&state=${state}`)
    );
    expect(response2.status).toBeGreaterThanOrEqual(400);
    expect(await response2.text()).toContain("State not found or already used");
  });

  it("should reject state with mismatched serverId", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverIdA = nanoid(8);
    const serverIdB = nanoid(8);
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdA}, ${"server-a"}, ${"http://example.com/mcp"}, ${"client-id"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverIdB}, ${"server-b"}, ${"http://example.com/mcp"}, ${"client-id"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverIdA,
      "server-a",
      "http://example.com/mcp",
      callbackUrl,
      "client-id"
    );
    await agentStub.setupMockOAuthState(serverIdA, "test-code", "test-state");

    await agentStub.setupMockMcpConnection(
      serverIdB,
      "server-b",
      "http://example.com/mcp",
      callbackUrl,
      "client-id"
    );
    await agentStub.setupMockOAuthState(serverIdB, "test-code", "test-state");

    const nonce = nanoid();
    agentStub.saveStateForTest(nonce, serverIdA);
    const tamperedState = `${nonce}.${serverIdB}`;

    const response = await agentStub.fetch(
      new Request(`${callbackUrl}?code=test-code&state=${tamperedState}`)
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain("State serverId mismatch");
  });
});

describe("OAuth2 MCP Client - Custom Handler", () => {
  it("should use custom handler for OAuth callback response", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    // Configure custom JSON handler (functions can't cross DO boundary, so use flag)
    await agentStub.configureOAuthForTest({ useJsonHandler: true });

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client-id"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackUrl,
      "client-id"
    );

    const state = createStateWithSetup(agentStub, serverId);
    const response = await agentStub.fetch(
      new Request(`${callbackUrl}?code=test-code&state=${state}`)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as {
      custom: boolean;
      serverId: string;
      success: boolean;
    };
    expect(body.custom).toBe(true);
    expect(body.serverId).toBe(serverId);
    expect(body.success).toBe(true);
  });

  it("should use custom handler for OAuth error response", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);
    const serverId = nanoid(8);
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    await agentStub.setName("default");
    await agentStub.onStart();

    // Configure custom JSON handler
    await agentStub.configureOAuthForTest({ useJsonHandler: true });

    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${serverId}, ${"test"}, ${"http://example.com/mcp"}, ${"client-id"}, ${"http://example.com/auth"}, ${callbackUrl}, ${null})
    `;

    await agentStub.setupMockMcpConnection(
      serverId,
      "test",
      "http://example.com/mcp",
      callbackUrl,
      "client-id"
    );

    const state = createStateWithSetup(agentStub, serverId);
    // Send OAuth error
    const response = await agentStub.fetch(
      new Request(
        `${callbackUrl}?error=access_denied&error_description=User%20denied&state=${state}`
      )
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { custom: boolean; error: string };
    expect(body.custom).toBe(true);
    expect(body.error).toBe("User denied");
  });
});
