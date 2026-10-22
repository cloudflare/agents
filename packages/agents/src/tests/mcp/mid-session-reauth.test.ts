import { UnauthorizedError } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  MCPAuthorizationRequiredError,
  type MCPClientManager
} from "../../mcp/client";
import { isUnauthorized } from "../../mcp/client/errors";
import { withMcpHarness } from "../shared/mcp-harness";

/**
 * Mid-session re-authorization: a request on a `ready` connection that needs
 * a scope the grant lacks (`403 insufficient_scope`). The fake server below
 * is a complete OAuth-protected MCP server (protected-resource metadata,
 * authorization-server metadata, dynamic client registration, token
 * endpoint), reached through the transport's `fetch` option, so the real SDK
 * transport, `auth()` and `DurableObjectOAuthClientProvider` run end to end.
 */

const ORIGIN = "https://stepup-mcp.example.com";
const MCP_URL = `${ORIGIN}/mcp`;
const CALLBACK_URL = "http://localhost:3000/callback";
const BASE_SCOPE = "user:read account:read";
const WRITE_SCOPE = "workers_scripts:write";

function createFakeOAuthMcpServer() {
  const tokens = new Map<string, string>(); // access token -> scope
  const codes = new Map<string, string>(); // authorization code -> scope
  const tokenRequests: URLSearchParams[] = [];
  const options = { failRefresh: false };

  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers }
    });
  const challenge = (status: number, scope: string, error?: string) =>
    new Response("", {
      status,
      headers: {
        "www-authenticate": `Bearer ${error ? `error="${error}", ` : ""}scope="${scope}", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
      }
    });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) {
      throw new Error(`Unexpected fetch: ${request.url}`);
    }

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: MCP_URL,
        authorization_servers: [ORIGIN],
        scopes_supported: BASE_SCOPE.split(" ")
      });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (url.pathname.startsWith("/.well-known/")) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/register") {
      const body = (await request.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, client_id: "client-1" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(await request.text());
      tokenRequests.push(params);
      const scope =
        params.get("grant_type") === "authorization_code"
          ? codes.get(params.get("code") ?? "")
          : options.failRefresh
            ? undefined
            : BASE_SCOPE;
      if (!scope) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
      const accessToken = `token-${tokens.size + 1}`;
      tokens.set(accessToken, scope);
      return json({
        access_token: accessToken,
        token_type: "Bearer",
        scope,
        refresh_token: `refresh-${accessToken}`,
        expires_in: 3600
      });
    }
    if (url.pathname === "/mcp") {
      const scope = tokens.get(
        (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      );
      if (!scope) return challenge(401, BASE_SCOPE);
      if (request.method === "GET" || request.method === "DELETE") {
        return new Response(null, { status: 405 });
      }
      const message = (await request.json()) as {
        id?: number;
        method?: string;
      };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const ok = (result: unknown) =>
        json(
          { jsonrpc: "2.0", id: message.id, result },
          { "mcp-session-id": "session-1" }
        );
      switch (message.method) {
        case "initialize":
          return ok({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stepup", version: "1.0.0" }
          });
        case "tools/list":
          return ok({
            tools: [
              {
                name: "write",
                inputSchema: { type: "object", properties: {} }
              }
            ]
          });
        case "tools/call":
          if (!scope.split(" ").includes(WRITE_SCOPE)) {
            return challenge(
              403,
              `${BASE_SCOPE} ${WRITE_SCOPE}`,
              "insufficient_scope"
            );
          }
          return ok({ content: [{ type: "text", text: "wrote it" }] });
        default:
          return ok({});
      }
    }
    return new Response("Not found", { status: 404 });
  };

  return {
    fetch,
    codes,
    tokenRequests,
    options,
    revokeAllTokens: () => tokens.clear()
  };
}

function callbackRequest(authUrl: string, code: string): Request {
  const state = new URL(authUrl).searchParams.get("state");
  if (!state) throw new Error(`authUrl has no state: ${authUrl}`);
  return new Request(
    `${CALLBACK_URL}?code=${code}&state=${encodeURIComponent(state)}`
  );
}

async function connectWithGrant(
  manager: MCPClientManager,
  server: ReturnType<typeof createFakeOAuthMcpServer>,
  serverId: string,
  scope: string
): Promise<string> {
  await manager.registerServer(serverId, {
    url: MCP_URL,
    name: "Step-up server",
    callbackUrl: CALLBACK_URL,
    client: {},
    transport: { type: "streamable-http", fetch: server.fetch }
  });
  const connected = await manager.connectToServer(serverId);
  if (connected.state !== "authenticating") {
    throw new Error(`expected authenticating, got ${connected.state}`);
  }
  const code = `code-${serverId}`;
  server.codes.set(code, scope);
  const result = await manager.handleCallbackRequest(
    callbackRequest(connected.authUrl, code)
  );
  expect(result.authSuccess).toBe(true);
  await manager.establishConnection(serverId);
  expect(manager.mcpConnections[serverId].connectionState).toBe("ready");
  return connected.authUrl;
}

/** Point the provider at a new authorization URL with a redeemable state. */
async function holdRedeemableUrl(
  conn: MCPClientManager["mcpConnections"][string]
): Promise<string> {
  const provider = conn.options.transport.authProvider as
    | (NonNullable<typeof conn.options.transport.authProvider> & {
        state(): Promise<string>;
      })
    | undefined;
  if (!provider) throw new Error("expected an auth provider");
  const url = new URL(`${ORIGIN}/authorize`);
  url.searchParams.set("state", await provider.state());
  await provider.redirectToAuthorization(url);
  return url.toString();
}

describe("MCPClientManager mid-session re-authorization", () => {
  it("surfaces a scope step-up on callTool and completes it through the OAuth callback", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const server = createFakeOAuthMcpServer();
      const serverId = "stepup-server";
      const serverStateChanged = vi.fn();
      manager.onServerStateChanged(serverStateChanged);

      await manager.registerServer(serverId, {
        url: MCP_URL,
        name: "Step-up server",
        callbackUrl: CALLBACK_URL,
        client: {},
        transport: { type: "streamable-http", fetch: server.fetch }
      });

      // Connect: 401 -> authorize with the base scope -> callback -> ready.
      const connected = await manager.connectToServer(serverId);
      expect(connected.state).toBe("authenticating");
      if (connected.state !== "authenticating") return;
      expect(new URL(connected.authUrl).searchParams.get("scope")).toBe(
        BASE_SCOPE
      );
      server.codes.set("code-base", BASE_SCOPE);
      const first = await manager.handleCallbackRequest(
        callbackRequest(connected.authUrl, "code-base")
      );
      expect(first.authSuccess).toBe(true);
      await manager.establishConnection(serverId);
      expect(manager.mcpConnections[serverId].connectionState).toBe("ready");

      // A call that needs more scope: typed error carrying the new URL.
      serverStateChanged.mockClear();
      const error = await manager
        .callTool({ serverId, name: "write", arguments: {} })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(error).toBeInstanceOf(MCPAuthorizationRequiredError);
      const stepUp = error as MCPAuthorizationRequiredError;
      expect(stepUp.serverId).toBe(serverId);
      expect(stepUp.authUrl).not.toBe(connected.authUrl);
      expect(new URL(stepUp.authUrl).searchParams.get("scope")).toBe(
        `${BASE_SCOPE} ${WRITE_SCOPE}`
      );
      // Existing checks keep matching.
      expect(stepUp).toBeInstanceOf(UnauthorizedError);
      expect(stepUp.name).toBe("UnauthorizedError");
      expect(isUnauthorized(stepUp)).toBe(true);

      // The connection waits for the callback, and the URL is servable.
      expect(manager.mcpConnections[serverId].connectionState).toBe(
        "authenticating"
      );
      expect(
        harness.serverRows().find((row) => row.id === serverId)?.auth_url
      ).toBe(stepUp.authUrl);
      expect(serverStateChanged).toHaveBeenCalled();

      // The callback exchanges the new code instead of dropping it as stale.
      server.codes.set("code-write", `${BASE_SCOPE} ${WRITE_SCOPE}`);
      const second = await manager.handleCallbackRequest(
        callbackRequest(stepUp.authUrl, "code-write")
      );
      expect(second.authSuccess).toBe(true);
      expect(
        server.tokenRequests.some(
          (params) =>
            params.get("grant_type") === "authorization_code" &&
            params.get("code") === "code-write"
        )
      ).toBe(true);
      await manager.establishConnection(serverId);
      expect(manager.mcpConnections[serverId].connectionState).toBe("ready");
      expect(
        harness.serverRows().find((row) => row.id === serverId)?.auth_url ??
          null
      ).toBeNull();

      // Retry succeeds with the wider grant.
      const retry = await manager.callTool({
        serverId,
        name: "write",
        arguments: {}
      });
      expect(retry.content).toEqual([{ type: "text", text: "wrote it" }]);
    });
  });

  it("surfaces a 401 whose token refresh fails", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const server = createFakeOAuthMcpServer();
      const serverId = "stepup-server-revoked";
      const connectUrl = await connectWithGrant(
        manager,
        server,
        serverId,
        `${BASE_SCOPE} ${WRITE_SCOPE}`
      );

      server.revokeAllTokens();
      server.options.failRefresh = true;
      const error = await manager
        .callTool({ serverId, name: "write", arguments: {} })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(error).toBeInstanceOf(MCPAuthorizationRequiredError);
      const reauth = error as MCPAuthorizationRequiredError;
      expect(reauth.authUrl).not.toBe(connectUrl);
      expect(manager.mcpConnections[serverId].connectionState).toBe(
        "authenticating"
      );
      expect(
        harness.serverRows().find((row) => row.id === serverId)?.auth_url
      ).toBe(reauth.authUrl);
      expect(
        server.tokenRequests.some(
          (params) => params.get("grant_type") === "refresh_token"
        )
      ).toBe(true);

      server.codes.set("code-again", `${BASE_SCOPE} ${WRITE_SCOPE}`);
      const result = await manager.handleCallbackRequest(
        callbackRequest(reauth.authUrl, "code-again")
      );
      expect(result.authSuccess).toBe(true);
      await manager.establishConnection(serverId);
      expect(manager.mcpConnections[serverId].connectionState).toBe("ready");
    });
  });

  it("handles two calls that need re-authorization at once", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const server = createFakeOAuthMcpServer();
      const serverId = "stepup-server-concurrent";
      await connectWithGrant(manager, server, serverId, BASE_SCOPE);

      const settle = (p: Promise<unknown>) =>
        p.then(
          () => undefined,
          (e: unknown) => e
        );
      const [a, b] = await Promise.all([
        settle(manager.callTool({ serverId, name: "write", arguments: {} })),
        settle(manager.callTool({ serverId, name: "write", arguments: {} }))
      ]);
      expect(a).toBeInstanceOf(MCPAuthorizationRequiredError);
      expect(b).toBeInstanceOf(MCPAuthorizationRequiredError);
      const urls = [a, b].map(
        (e) => (e as MCPAuthorizationRequiredError).authUrl
      );
      expect(manager.mcpConnections[serverId].connectionState).toBe(
        "authenticating"
      );
      const saved = harness
        .serverRows()
        .find((row) => row.id === serverId)?.auth_url;
      expect(urls).toContain(saved);

      // Either link completes the flow; the other is then a stale success.
      server.codes.set("code-a", `${BASE_SCOPE} ${WRITE_SCOPE}`);
      expect(
        (
          await manager.handleCallbackRequest(
            callbackRequest(urls[0], "code-a")
          )
        ).authSuccess
      ).toBe(true);
      await manager.establishConnection(serverId);
      expect(manager.mcpConnections[serverId].connectionState).toBe("ready");
      server.codes.set("code-b", `${BASE_SCOPE} ${WRITE_SCOPE}`);
      expect(
        (
          await manager.handleCallbackRequest(
            callbackRequest(urls[1], "code-b")
          )
        ).authSuccess
      ).toBe(true);
      expect(manager.mcpConnections[serverId].connectionState).toBe("ready");
      expect(
        server.tokenRequests.some((params) => params.get("code") === "code-b")
      ).toBe(false);
    });
  });

  it("ignores a changed URL whose flow is already completed", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const server = createFakeOAuthMcpServer();
      const serverId = "stepup-server-spent-url";
      const connectUrl = await connectWithGrant(
        manager,
        server,
        serverId,
        BASE_SCOPE
      );

      // While a request runs, the provider ends up holding a URL whose state
      // nonce was already used (another flow finished meanwhile).
      const conn = manager.mcpConnections[serverId];
      const provider = conn.options.transport.authProvider;
      if (!provider) throw new Error("expected an auth provider");
      const unauthorized = new UnauthorizedError("Unauthorized");
      vi.spyOn(conn.client, "callTool").mockImplementationOnce(async () => {
        const spent = new URL(connectUrl);
        spent.searchParams.set("prompt", "consent");
        await provider.redirectToAuthorization(spent);
        throw unauthorized;
      });
      await expect(
        manager.callTool({ serverId, name: "write", arguments: {} })
      ).rejects.toBe(unauthorized);
      expect(conn.connectionState).toBe("ready");
    });
  });

  it("rethrows non-auth errors unchanged and leaves the connection ready", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const server = createFakeOAuthMcpServer();
      const serverId = "stepup-server-unknown-tool";
      await connectWithGrant(
        manager,
        server,
        serverId,
        `${BASE_SCOPE} ${WRITE_SCOPE}`
      );

      const boom = new Error("boom");
      const conn = manager.mcpConnections[serverId];
      vi.spyOn(conn.client, "callTool").mockRejectedValueOnce(boom);
      await expect(
        manager.callTool({ serverId, name: "write", arguments: {} })
      ).rejects.toBe(boom);
      expect(conn.connectionState).toBe("ready");
    });
  });

  it("rethrows an unauthorized error when the authorization URL did not change", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const server = createFakeOAuthMcpServer();
      const serverId = "stepup-server-same-url";
      await connectWithGrant(manager, server, serverId, BASE_SCOPE);

      // The provider holds a redeemable URL from before the call; the call
      // fails without starting a new flow.
      const conn = manager.mcpConnections[serverId];
      await holdRedeemableUrl(conn);
      const unauthorized = new UnauthorizedError("Unauthorized");
      vi.spyOn(conn.client, "callTool").mockRejectedValueOnce(unauthorized);
      await expect(
        manager.callTool({ serverId, name: "write", arguments: {} })
      ).rejects.toBe(unauthorized);
      expect(conn.connectionState).toBe("ready");
    });
  });

  it("leaves a connection that is processing a callback alone", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const server = createFakeOAuthMcpServer();
      const serverId = "stepup-server-connecting";
      await connectWithGrant(manager, server, serverId, BASE_SCOPE);

      // A callback has moved the connection to `connecting` while a call on
      // the old transport fails and the SDK starts another flow.
      const conn = manager.mcpConnections[serverId];
      const unauthorized = new UnauthorizedError("Unauthorized");
      vi.spyOn(conn.client, "callTool").mockImplementationOnce(async () => {
        conn.connectionState = "connecting";
        await holdRedeemableUrl(conn);
        throw unauthorized;
      });
      await expect(
        manager.callTool({ serverId, name: "write", arguments: {} })
      ).rejects.toBe(unauthorized);
      expect(conn.connectionState).toBe("connecting");
      expect(
        harness.serverRows().find((row) => row.id === serverId)?.auth_url ??
          null
      ).toBeNull();
    });
  });
});
