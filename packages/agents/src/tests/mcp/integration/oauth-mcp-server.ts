import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/server";
import { http, type HttpHandler } from "msw";
import { createMcpHandler } from "../../../mcp";

/**
 * An OAuth-protected MCP server for integration tests, served through msw.
 *
 * The resource server answers at {@link MCP_URL}: protected-resource metadata,
 * a bearer check, a `403 insufficient_scope` step-up for the `write` tool, and
 * a real MCP endpoint built with `createMcpHandler`. The authorization server
 * at {@link AUTH_ORIGIN} serves metadata, dynamic client registration and a
 * token endpoint that checks PKCE and the redirect URI.
 *
 * Nothing is injected into the client. msw intercepts `fetch` across the test
 * isolate, so the agent's default transport and the SDK's OAuth discovery run
 * exactly as they do in production. The test plays the user with
 * {@link OAuthMcpServer.authorize}, which approves an authorization URL and
 * returns the callback URL the browser would be sent to.
 */

export const MCP_ORIGIN = "https://mcp.integration.example";
export const MCP_URL = `${MCP_ORIGIN}/mcp`;
export const AUTH_ORIGIN = "https://auth.integration.example";
export const CLIENT_ORIGIN = "https://client.integration.example";

export const READ_SCOPE = "files:read";
export const WRITE_SCOPE = "files:write";
/** The `admin` tool's step-up scope, named like an `Object` member. */
export const ADMIN_SCOPE = "constructor";

const RESOURCE_METADATA_URL = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

type Grant = { scope: string };
type PendingCode = Grant & {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
};

export type OAuthMcpServer = ReturnType<typeof createOAuthMcpServer>;

export function createOAuthMcpServer() {
  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const codes = new Map<string, PendingCode>();
  let issued = 0;

  const options = {
    /** The resource server answers every request with 503 while false. */
    up: true,
    /** The token endpoint refuses every refresh token while true. */
    refuseRefresh: false,
    /**
     * Serve the handshake (`initialize`, `server/discover`, notifications)
     * without a token and protect only the rest, as some servers do.
     */
    openHandshake: false,
    /** The scope a `401` challenge asks for. */
    challengeScope: READ_SCOPE
  };

  /** While set, requests to the held endpoint wait before they are answered. */
  let held: Promise<void> | undefined;
  let heldEndpoint: "mcp" | "token" = "mcp";
  let releaseHeld = () => {};

  /** Every token request the authorization server received. */
  const tokenRequests: URLSearchParams[] = [];
  /** Every MCP method the resource server served, in order. */
  const mcpMethods: string[] = [];

  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer({ name: "files", version: "1.0.0" });
    server.registerTool("read", { inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "read it" }]
    }));
    server.registerTool("write", { inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "wrote it" }]
    }));
    server.registerTool("admin", { inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "administered it" }]
    }));
    return server;
  });

  function challenge(
    status: 401 | 403,
    scope: string,
    error?: string
  ): Response {
    const parts = [
      error && `error="${error}"`,
      `scope="${scope}"`,
      `resource_metadata="${RESOURCE_METADATA_URL}"`
    ].filter(Boolean);
    return new Response(null, {
      status,
      headers: { "www-authenticate": `Bearer ${parts.join(", ")}` }
    });
  }

  function issue(scope: string) {
    issued += 1;
    const accessToken = `access-${issued}`;
    const refreshToken = `refresh-${issued}`;
    accessTokens.set(accessToken, { scope });
    refreshTokens.set(refreshToken, { scope });
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope
    });
  }

  async function s256(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );
    let binary = "";
    for (const byte of new Uint8Array(digest)) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /** Which MCP method and tool name a request carries. */
  async function describeRequest(
    request: Request
  ): Promise<{ method?: string; tool?: string }> {
    const headerMethod = request.headers.get("mcp-method") ?? undefined;
    const headerName = request.headers.get("mcp-name") ?? undefined;
    if (headerMethod) return { method: headerMethod, tool: headerName };
    if (request.method !== "POST") return {};
    try {
      const body = (await request.clone().json()) as {
        method?: string;
        params?: { name?: string };
      };
      return { method: body.method, tool: body.params?.name };
    } catch {
      return {};
    }
  }

  async function resourceServer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: MCP_URL,
        authorization_servers: [AUTH_ORIGIN],
        scopes_supported: [READ_SCOPE, WRITE_SCOPE, ADMIN_SCOPE]
      });
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (held && heldEndpoint === "mcp") await held;
    if (!options.up) return new Response("unavailable", { status: 503 });

    const token = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /,
      ""
    );
    const grant = accessTokens.get(token);
    const { method, tool } = await describeRequest(request);
    const handshake =
      method === "initialize" ||
      method === "server/discover" ||
      method?.startsWith("notifications/");
    if (!grant && !(options.openHandshake && handshake)) {
      return challenge(401, options.challengeScope);
    }
    if (method) mcpMethods.push(method);
    const granted = grant?.scope.split(" ") ?? [];
    if (method === "tools/call") {
      if (tool === "write" && !granted.includes(WRITE_SCOPE)) {
        return challenge(
          403,
          `${READ_SCOPE} ${WRITE_SCOPE}`,
          "insufficient_scope"
        );
      }
      if (tool === "admin" && !granted.includes(ADMIN_SCOPE)) {
        return challenge(403, ADMIN_SCOPE, "insufficient_scope");
      }
    }
    return mcpHandler(request, env, createExecutionContext());
  }

  async function authorizationServer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: AUTH_ORIGIN,
        authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
        token_endpoint: `${AUTH_ORIGIN}/token`,
        registration_endpoint: `${AUTH_ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [READ_SCOPE, WRITE_SCOPE]
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const metadata = (await request.json()) as Record<string, unknown>;
      return Response.json(
        { ...metadata, client_id: `client-${crypto.randomUUID()}` },
        { status: 201 }
      );
    }
    if (url.pathname === "/token" && request.method === "POST") {
      if (held && heldEndpoint === "token") await held;
      const params = new URLSearchParams(await request.text());
      tokenRequests.push(params);
      const invalidGrant = () =>
        Response.json({ error: "invalid_grant" }, { status: 400 });

      if (params.get("grant_type") === "refresh_token") {
        const grant = refreshTokens.get(params.get("refresh_token") ?? "");
        if (!grant || options.refuseRefresh) return invalidGrant();
        return issue(grant.scope);
      }

      const pending = codes.get(params.get("code") ?? "");
      codes.delete(params.get("code") ?? "");
      if (
        !pending ||
        pending.redirectUri !== params.get("redirect_uri") ||
        pending.clientId !== params.get("client_id") ||
        pending.codeChallenge !==
          (await s256(params.get("code_verifier") ?? ""))
      ) {
        return invalidGrant();
      }
      return issue(pending.scope);
    }
    return new Response("Not found", { status: 404 });
  }

  // msw types its requests with the DOM `Request`; at runtime they are the
  // Workers `Request` the client sent.
  const handlers: HttpHandler[] = [
    http.all(`${MCP_ORIGIN}/*`, ({ request }) =>
      resourceServer(request as unknown as Request)
    ),
    http.all(`${AUTH_ORIGIN}/*`, ({ request }) =>
      authorizationServer(request as unknown as Request)
    )
  ];

  return {
    handlers,
    options,
    tokenRequests,
    mcpMethods,

    /**
     * Approve an authorization URL as the user would, and return the callback
     * URL the authorization server redirects the browser to. Grants the scope
     * the URL asked for unless `grant` says otherwise.
     */
    authorize(authUrl: string, grant?: { scope: string }): string {
      const url = new URL(authUrl);
      if (url.origin !== AUTH_ORIGIN || url.pathname !== "/authorize") {
        throw new Error(`Not an authorization URL: ${authUrl}`);
      }
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");
      const clientId = url.searchParams.get("client_id");
      if (!redirectUri || !state || !codeChallenge || !clientId) {
        throw new Error(`Incomplete authorization URL: ${authUrl}`);
      }
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, {
        scope: grant?.scope ?? url.searchParams.get("scope") ?? READ_SCOPE,
        codeChallenge,
        redirectUri,
        clientId
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      return callback.toString();
    },

    /** The scope an authorization URL asks for. */
    requestedScope(authUrl: string): string | null {
      return new URL(authUrl).searchParams.get("scope");
    },

    /**
     * Hold requests to the MCP endpoint, or to the token endpoint, until the
     * returned function is called, so a test can act while a connection
     * attempt or a code exchange is in flight.
     */
    holdRequests(endpoint: "mcp" | "token" = "mcp"): () => void {
      heldEndpoint = endpoint;
      let resolve!: () => void;
      held = new Promise((r) => {
        resolve = r;
      });
      releaseHeld = () => {
        held = undefined;
        resolve();
      };
      return releaseHeld;
    },

    /** Invalidate every access token, so the next request gets a 401. */
    revokeAccessTokens(): void {
      accessTokens.clear();
    },

    reset(): void {
      accessTokens.clear();
      refreshTokens.clear();
      codes.clear();
      tokenRequests.length = 0;
      mcpMethods.length = 0;
      options.up = true;
      options.refuseRefresh = false;
      options.openHandshake = false;
      options.challengeScope = READ_SCOPE;
      releaseHeld();
    }
  };
}
