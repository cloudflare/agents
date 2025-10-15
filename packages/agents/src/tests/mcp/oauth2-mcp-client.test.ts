import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../worker";
import { nanoid } from "nanoid";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("OAuth2 MCP Client", () => {
  it(
    "hibernated durable object should restore MCP state from database during OAuth callback",
    { timeout: 10000 },
    async () => {
      // Use idFromName to ensure we get the same DO instance across requests
      const agentId = env.TestOAuthAgent.idFromName("test-oauth-hibernation");
      const agentStub = env.TestOAuthAgent.get(agentId);

      // Initialize the agent
      await agentStub.setName("default");
      await agentStub.onStart();

      // Setup: Simulate a persisted MCP server that was saved before hibernation
      const serverId = nanoid(8);
      const serverName = "test-oauth-server";
      const serverUrl = "http://example.com/mcp";
      const clientId = "test-client-id";
      const authUrl = "http://example.com/oauth/authorize";
      const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

      // Insert the MCP server record into the database (simulating pre-OAuth persistence)
      agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (
        ${serverId},
        ${serverName},
        ${serverUrl},
        ${clientId},
        ${authUrl},
        ${callbackBaseUrl},
        ${null}
      )
    `;

      // At this point, the DO has never had internal state, similar to one which had just "hibernates"
      // When it wakes up for the OAuth callback, it should restore state from the database

      // Verify callback URL is NOT registered before the callback (simulating hibernation)
      const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;
      const isRegisteredBefore = await agentStub.isCallbackUrlRegistered(
        `${fullCallbackUrl}?code=test&state=test`
      );
      expect(isRegisteredBefore).toBe(false);

      // Simulate the OAuth callback request
      const authCode = "test-auth-code";
      const state = "test-state";
      const callbackUrl = `${callbackBaseUrl}/${serverId}?code=${authCode}&state=${state}`;
      const request = new Request(callbackUrl, { method: "GET" });

      const response = await agentStub.fetch(request);

      // The restoration worked if we get past the "Server not found" error
      // The server should be found in the database and the callback URL should be restored
      const responseText = await response.text();

      // We should NOT get a 404 (that would mean restoration failed)
      expect(response.status).not.toBe(404);
      expect(responseText).not.toContain("not found in database");

      // Verify the callback URL was restored/registered in memory during the request processing
      // This happens in _handlePotentialOAuthCallback before attempting to process the callback
      const isRegisteredAfter = await agentStub.isCallbackUrlRegistered(
        `${fullCallbackUrl}?code=test&state=test`
      );
      expect(isRegisteredAfter).toBe(true);

      // Verify database record still exists after callback
      const serverAfter = await agentStub.getMcpServerFromDb(serverId);
      expect(serverAfter).not.toBeNull();
      expect(serverAfter?.id).toBe(serverId);
    }
  );

  it("should handle callback when server record exists and connection is still in memory", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    await agentStub.setName("default");
    await agentStub.onStart();

    const serverId = nanoid(8);
    const serverName = "test-server";
    const serverUrl = "http://example.com/mcp";
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    // Insert server record in database
    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (
        ${serverId},
        ${serverName},
        ${serverUrl},
        ${"client-id"},
        ${"http://example.com/auth"},
        ${callbackBaseUrl},
        ${null}
      )
    `;

    // Setup in-memory state (simulates non-hibernated DO)
    await agentStub.setupMockMcpConnection(
      serverId,
      serverName,
      serverUrl,
      callbackBaseUrl
    );

    // Verify callback URL is already registered before making the callback request
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;
    const isRegisteredBefore = await agentStub.isCallbackUrlRegistered(
      `${fullCallbackUrl}?code=test&state=test`
    );
    expect(isRegisteredBefore).toBe(true);

    // Verify database state before callback
    const serverBefore = await agentStub.getMcpServerFromDb(serverId);
    expect(serverBefore).not.toBeNull();
    expect(serverBefore?.id).toBe(serverId);

    // Set up mock OAuth state so the callback can succeed
    const authCode = "test-code";
    const state = "test-state";
    await agentStub.setupMockOAuthState(serverId, authCode, state);

    const callbackUrl = `${callbackBaseUrl}/${serverId}?code=${authCode}&state=${state}`;
    const request = new Request(callbackUrl, { method: "GET" });

    const response = await agentStub.fetch(request);

    // Should not crash - the callback URL is already registered in memory
    // so _restoreMcpStateForOAuthCallback should be idempotent
    expect(response.status).toBe(200);

    // Verify callback URL is still registered after callback (idempotent)
    const isRegisteredAfter = await agentStub.isCallbackUrlRegistered(
      `${fullCallbackUrl}?code=test&state=test`
    );
    expect(isRegisteredAfter).toBe(true);

    // Verify database record persists after callback
    const serverAfter = await agentStub.getMcpServerFromDb(serverId);
    expect(serverAfter).not.toBeNull();
    expect(serverAfter?.id).toBe(serverId);
  });

  it("should not restore state for non-callback requests", async () => {
    const ctx = createExecutionContext();

    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    await agentStub.setName("default");
    await agentStub.onStart();

    const regularUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}`;
    const request = new Request(regularUrl, { method: "GET" });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("Test OAuth Agent");
  });

  it("should handle callback with missing server record gracefully", async () => {
    const ctx = createExecutionContext();

    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    await agentStub.setName("default");
    await agentStub.onStart();

    const nonExistentServerId = nanoid(8);
    const callbackUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback/${nonExistentServerId}?code=test-code&state=test-state`;
    const request = new Request(callbackUrl, { method: "GET" });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(404);
  });

  it("should restore connection when callback URL is registered but connection is missing", async () => {
    // Not sure how this happens in practise but it does

    const agentId = env.TestOAuthAgent.idFromName("test-partial-state");
    const agentStub = env.TestOAuthAgent.get(agentId);

    await agentStub.setName("default");
    await agentStub.onStart();

    const serverId = nanoid(8);
    const serverName = "test-server";
    const serverUrl = "http://example.com/mcp";
    const clientId = "test-client-id";
    const authUrl = "http://example.com/oauth/authorize";
    const callbackBaseUrl = `http://example.com/agents/test-o-auth-agent/${agentId.toString()}/callback`;

    // Insert server record in database
    agentStub.sql`
      INSERT INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (
        ${serverId},
        ${serverName},
        ${serverUrl},
        ${clientId},
        ${authUrl},
        ${callbackBaseUrl},
        ${null}
      )
    `;

    // Simulate partial state: callback URL is registered but connection is missing
    // This is the bug scenario - callback URL exists but no connection
    const fullCallbackUrl = `${callbackBaseUrl}/${serverId}`;
    await agentStub.setupMockMcpConnection(
      serverId,
      serverName,
      serverUrl,
      callbackBaseUrl
    );

    // Verify callback URL IS registered
    const isRegisteredBefore = await agentStub.isCallbackUrlRegistered(
      `${fullCallbackUrl}?code=test&state=test`
    );
    expect(isRegisteredBefore).toBe(true);

    // Now REMOVE the connection from mcpConnections to simulate the bug scenario
    // The callback URL is registered, but the connection object is missing
    await agentStub.removeMcpConnection(serverId);

    // Verify connection is missing
    const connectionExists = await agentStub.hasMcpConnection(serverId);
    expect(connectionExists).toBe(false);

    const authCode = "test-code";
    const state = "test-state";
    const callbackUrl = `${callbackBaseUrl}/${serverId}?code=${authCode}&state=${state}`;
    const request = new Request(callbackUrl, { method: "GET" });

    const response = await agentStub.fetch(request);

    // Before this would fail with "Could not find serverId: xxx"
    const responseText = await response.text();
    expect(responseText).not.toContain("Could not find serverId");

    // Should not be 404 (would mean restoration didn't work)
    expect(response.status).not.toBe(404);

    // Verify the callback URL is still registered after restoration
    const isRegisteredAfter = await agentStub.isCallbackUrlRegistered(
      `${fullCallbackUrl}?code=test&state=test`
    );
    expect(isRegisteredAfter).toBe(true);
  });
});
