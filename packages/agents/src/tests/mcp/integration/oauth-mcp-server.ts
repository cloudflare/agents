import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/server";
import { http, type HttpHandler } from "msw";
import { createMcpHandler } from "../../../mcp";

/**
 * An OAuth-protected MCP server for integration tests, served through msw.
 *
 * The resource server answers at `<origin>/mcp`, and over the older SSE
 * transport at `<origin>/sse` with a per-session message endpoint. It serves
 * protected-resource metadata,
 * a bearer check, `403 insufficient_scope` step-ups for the operations listed
 * in {@link STEP_UPS}, and a real MCP endpoint built with `createMcpHandler`.
 * The authorization server serves metadata, dynamic client registration and
 * a token endpoint that checks PKCE, the redirect URI and the client id, and
 * rotates refresh tokens.
 *
 * Nothing is injected into the client. msw intercepts `fetch` across the test
 * isolate, so the agent's default transport and the SDK's OAuth discovery run
 * exactly as they do in production. The test plays the user with
 * {@link OAuthMcpServer.authorize} and {@link OAuthMcpServer.deny}, which
 * return the callback URL the browser would be sent to.
 */

export const MCP_ORIGIN = "https://mcp.integration.example";
export const MCP_URL = `${MCP_ORIGIN}/mcp`;
export const AUTH_ORIGIN = "https://auth.integration.example";
export const CLIENT_ORIGIN = "https://client.integration.example";

export const READ_SCOPE = "files:read";
export const WRITE_SCOPE = "files:write";
/** The `admin` tool's step-up scope, named like an `Object` member. */
export const ADMIN_SCOPE = "constructor";

/** A resource anyone with a token can read. */
export const NOTES_URI = "files://notes";
/** A resource that needs {@link WRITE_SCOPE}. */
export const SECRET_URI = "files://secret";

/**
 * Operations that need more than a token, and the scope their `403`
 * challenge asks for.
 */
const STEP_UPS: Array<{
  method: string;
  name: string;
  needs: string;
  challenge: string;
}> = [
  {
    method: "tools/call",
    name: "write",
    needs: WRITE_SCOPE,
    challenge: `${READ_SCOPE} ${WRITE_SCOPE}`
  },
  {
    method: "resources/read",
    name: SECRET_URI,
    needs: WRITE_SCOPE,
    challenge: `${READ_SCOPE} ${WRITE_SCOPE}`
  },
  {
    method: "prompts/get",
    name: "draft",
    needs: WRITE_SCOPE,
    challenge: `${READ_SCOPE} ${WRITE_SCOPE}`
  },
  {
    method: "tools/call",
    name: "admin",
    needs: ADMIN_SCOPE,
    challenge: ADMIN_SCOPE
  }
];

type Grant = { scope: string };
type PendingCode = Grant & {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
};

function createFilesServer(): McpServer {
  const server = new McpServer({ name: "files", version: "1.0.0" });
  const text = (value: string) => ({
    content: [{ type: "text" as const, text: value }]
  });
  server.registerTool("read", { inputSchema: {} }, async () => text("read it"));
  server.registerTool("write", { inputSchema: {} }, async () =>
    text("wrote it")
  );
  server.registerTool("admin", { inputSchema: {} }, async () =>
    text("administered it")
  );
  server.registerResource("notes", NOTES_URI, {}, async (uri) => ({
    contents: [{ uri: uri.href, text: "some notes" }]
  }));
  server.registerResource("secret", SECRET_URI, {}, async (uri) => ({
    contents: [{ uri: uri.href, text: "the secret" }]
  }));
  server.registerPrompt("draft", {}, async () => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: "a draft" }
      }
    ]
  }));
  return server;
}

export type OAuthMcpServer = ReturnType<typeof createOAuthMcpServer>;

export function createOAuthMcpServer({
  origin = MCP_ORIGIN,
  authOrigin = AUTH_ORIGIN
}: { origin?: string; authOrigin?: string } = {}) {
  const url = `${origin}/mcp`;
  const metadataPrefix = "/.well-known/oauth-protected-resource";

  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const codes = new Map<string, PendingCode>();
  let issued = 0;

  const options = {
    /** The resource server answers every request with 503 while false. */
    up: true,
    /** The token endpoint refuses every refresh token while true. */
    refuseRefresh: false,
    /** The token endpoint refuses every authorization code while true. */
    refuseCodes: false,
    /**
     * Serve the handshake (`initialize`, `server/discover`, notifications)
     * without a token and protect only the rest, as some servers do.
     */
    openHandshake: false,
    /** The scope a `401` challenge asks for. */
    challengeScope: READ_SCOPE,
    /**
     * Speak only the 2025-11-25 protocol, as an older server does: the
     * 2026-07-28 `server/discover` probe gets "method not found".
     */
    legacyOnly: false,
    /** Refuse every authorized MCP request with a plain 403. */
    forbidden: false,
    /** An OAuth error code the token endpoint answers every request with. */
    tokenError: undefined as string | undefined,
    /**
     * Accept only this static bearer token and serve no OAuth metadata, as a
     * server configured with an API key does.
     */
    staticToken: undefined as string | undefined
  };
  /** How many MCP requests the resource server refused with a 403. */
  let forbiddenResponses = 0;

  /** While set, requests to the held endpoint wait before they are answered. */
  let held: Promise<void> | undefined;
  let heldEndpoint: "mcp" | "token" = "mcp";
  let releaseHeld = () => {};
  /** How many requests are waiting at the hold right now. */
  let waiting = 0;

  async function waitIfHeld(endpoint: "mcp" | "token"): Promise<void> {
    if (!held || heldEndpoint !== endpoint) return;
    waiting += 1;
    try {
      await held;
    } finally {
      waiting -= 1;
    }
  }

  /** Open SSE streams, by session id. */
  const sseSessions = new Map<
    string,
    ReadableStreamDefaultController<Uint8Array>
  >();

  /** Every token request the authorization server received. */
  const tokenRequests: URLSearchParams[] = [];
  /** Every client id the authorization server registered. */
  const registeredClients: string[] = [];
  /** Every request the resource server refused with a 401, by MCP method. */
  const unauthorizedMethods: string[] = [];
  /** Every MCP method the resource server served, in order. */
  const mcpMethods: string[] = [];

  const mcpHandler = createMcpHandler(createFilesServer);

  function challenge(
    status: 401 | 403,
    scope: string,
    error?: string,
    resourcePath = "/mcp"
  ): Response {
    const parts = [
      error && `error="${error}"`,
      `scope="${scope}"`,
      `resource_metadata="${origin}${metadataPrefix}${resourcePath}"`
    ].filter(Boolean);
    return new Response(null, {
      status,
      headers: { "www-authenticate": `Bearer ${parts.join(", ")}` }
    });
  }

  function issue(scope: string) {
    issued += 1;
    const accessToken = `access-${origin}-${issued}`;
    const refreshToken = `refresh-${origin}-${issued}`;
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

  /** The JSON-RPC message a request carries, when it carries one. */
  async function readMessage(request: Request): Promise<{
    id?: string | number;
    method?: string;
    params?: { name?: string; uri?: string };
  }> {
    if (request.method !== "POST") return {};
    try {
      const body: unknown = await request.clone().json();
      return typeof body === "object" && body !== null && !Array.isArray(body)
        ? body
        : {};
    } catch {
      return {};
    }
  }

  async function resourceServer(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (options.staticToken !== undefined) return staticTokenServer(request);
    if (pathname.startsWith(metadataPrefix)) {
      // Each resource path has its own metadata: /mcp, or /sse for SSE.
      const resourcePath = pathname.slice(metadataPrefix.length) || "/mcp";
      return Response.json({
        resource: `${origin}${resourcePath}`,
        authorization_servers: [authOrigin],
        scopes_supported: [READ_SCOPE, WRITE_SCOPE, ADMIN_SCOPE]
      });
    }
    if (pathname === "/sse" || pathname === "/sse/message") {
      return sseServer(request);
    }
    if (pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    await waitIfHeld("mcp");
    if (!options.up) return new Response("unavailable", { status: 503 });

    const token = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /,
      ""
    );
    const grant = accessTokens.get(token);
    const message = await readMessage(request);
    const method = request.headers.get("mcp-method") ?? message.method;
    const name =
      message.params?.name ??
      message.params?.uri ??
      request.headers.get("mcp-name") ??
      undefined;
    const handshake =
      method === "initialize" ||
      method === "server/discover" ||
      method?.startsWith("notifications/");
    if (!grant && !(options.openHandshake && handshake)) {
      unauthorizedMethods.push(method ?? request.method);
      return challenge(401, options.challengeScope);
    }
    if (method) mcpMethods.push(method);
    if (options.forbidden) {
      forbiddenResponses += 1;
      return new Response("Forbidden", { status: 403 });
    }

    if (options.legacyOnly && method === "server/discover") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32601, message: "Method not found" }
      });
    }

    const granted = grant?.scope.split(" ") ?? [];
    const stepUp = STEP_UPS.find(
      (rule) => rule.method === method && rule.name === name
    );
    if (stepUp && !granted.includes(stepUp.needs)) {
      return challenge(403, stepUp.challenge, "insufficient_scope");
    }
    return mcpHandler(request, env, createExecutionContext());
  }

  /**
   * A minimal MCP server over the SSE transport: `GET /sse` opens a stream
   * that names a per-session message endpoint, and replies to the messages
   * posted there arrive on the stream. The stream is open; every message
   * needs a bearer token, so OAuth runs on the message endpoint.
   */
  async function sseServer(request: Request): Promise<Response> {
    await waitIfHeld("mcp");
    if (!options.up) return new Response("unavailable", { status: 503 });
    const { pathname, searchParams } = new URL(request.url);
    const token = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /,
      ""
    );
    if (pathname === "/sse/message" && !accessTokens.get(token)) {
      unauthorizedMethods.push(`SSE ${request.method}`);
      return challenge(401, options.challengeScope, undefined, "/sse");
    }

    const encode = (text: string) => new TextEncoder().encode(text);
    if (pathname === "/sse" && request.method === "GET") {
      const sessionId = crypto.randomUUID();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseSessions.set(sessionId, controller);
          controller.enqueue(
            encode(
              `event: endpoint\ndata: /sse/message?sessionId=${sessionId}\n\n`
            )
          );
        },
        cancel() {
          sseSessions.delete(sessionId);
        }
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache"
        }
      });
    }
    const session = sseSessions.get(searchParams.get("sessionId") ?? "");
    if (pathname !== "/sse/message" || request.method !== "POST" || !session) {
      return new Response("Not found", { status: 404 });
    }
    const message = (await request.json()) as {
      id?: string | number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    if (message.method) mcpMethods.push(message.method);
    if (message.id !== undefined) {
      const result = (() => {
        switch (message.method) {
          case "initialize":
            return {
              protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "files-sse", version: "1.0.0" }
            };
          case "tools/list":
            return {
              tools: [{ name: "read", inputSchema: { type: "object" } }]
            };
          case "tools/call":
            return { content: [{ type: "text", text: "read it" }] };
          case "ping":
            return {};
          default:
            return undefined;
        }
      })();
      const reply =
        result === undefined
          ? {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Method not found" }
            }
          : { jsonrpc: "2.0", id: message.id, result };
      session.enqueue(
        encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
      );
    }
    return new Response("Accepted", { status: 202 });
  }

  /** The MCP endpoint behind a static bearer token, with no OAuth at all. */
  async function staticTokenServer(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (
      request.headers.get("authorization") !== `Bearer ${options.staticToken}`
    ) {
      unauthorizedMethods.push((await readMessage(request)).method ?? "GET");
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" }
      });
    }
    const message = await readMessage(request);
    if (message.method) mcpMethods.push(message.method);
    return mcpHandler(request, env, createExecutionContext());
  }

  async function authorizationServer(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: authOrigin,
        authorization_endpoint: `${authOrigin}/authorize`,
        token_endpoint: `${authOrigin}/token`,
        registration_endpoint: `${authOrigin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [READ_SCOPE, WRITE_SCOPE, ADMIN_SCOPE]
      });
    }
    if (pathname === "/register" && request.method === "POST") {
      const metadata = (await request.json()) as Record<string, unknown>;
      const clientId = `client-${crypto.randomUUID()}`;
      registeredClients.push(clientId);
      return Response.json(
        { ...metadata, client_id: clientId },
        { status: 201 }
      );
    }
    if (pathname === "/token" && request.method === "POST") {
      await waitIfHeld("token");
      const params = new URLSearchParams(await request.text());
      tokenRequests.push(params);
      if (options.tokenError) {
        return Response.json({ error: options.tokenError }, { status: 400 });
      }
      const invalidGrant = () =>
        Response.json({ error: "invalid_grant" }, { status: 400 });

      if (params.get("grant_type") === "refresh_token") {
        // Refresh tokens rotate: each one can be used once.
        const refreshToken = params.get("refresh_token") ?? "";
        const grant = refreshTokens.get(refreshToken);
        refreshTokens.delete(refreshToken);
        if (!grant || options.refuseRefresh) return invalidGrant();
        return issue(grant.scope);
      }

      const code = params.get("code") ?? "";
      const pending = codes.get(code);
      codes.delete(code);
      if (
        options.refuseCodes ||
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

  /** The parts of an authorization URL the callback needs. */
  function parseAuthorizationUrl(authUrl: string) {
    const parsed = new URL(authUrl);
    if (parsed.origin !== authOrigin || parsed.pathname !== "/authorize") {
      throw new Error(`Not an authorization URL: ${authUrl}`);
    }
    const redirectUri = parsed.searchParams.get("redirect_uri");
    const state = parsed.searchParams.get("state");
    const codeChallenge = parsed.searchParams.get("code_challenge");
    const clientId = parsed.searchParams.get("client_id");
    if (!redirectUri || !state || !codeChallenge || !clientId) {
      throw new Error(`Incomplete authorization URL: ${authUrl}`);
    }
    return {
      redirectUri,
      state,
      codeChallenge,
      clientId,
      scope: parsed.searchParams.get("scope")
    };
  }

  // msw types its requests with the DOM `Request`; at runtime they are the
  // Workers `Request` the client sent.
  const handlers: HttpHandler[] = [
    http.all(`${origin}/*`, ({ request }) =>
      resourceServer(request as unknown as Request)
    ),
    http.all(`${authOrigin}/*`, ({ request }) =>
      authorizationServer(request as unknown as Request)
    )
  ];

  return {
    url,
    /** The same server over the older SSE transport. */
    sseUrl: `${origin}/sse`,
    handlers,
    options,
    tokenRequests,
    mcpMethods,
    registeredClients,
    unauthorizedMethods,

    /**
     * Approve an authorization URL as the user would, and return the callback
     * URL the authorization server redirects the browser to. Grants the scope
     * the URL asked for unless `grant` says otherwise.
     */
    authorize(authUrl: string, grant?: { scope: string }): string {
      const request = parseAuthorizationUrl(authUrl);
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, {
        scope: grant?.scope ?? request.scope ?? READ_SCOPE,
        codeChallenge: request.codeChallenge,
        redirectUri: request.redirectUri,
        clientId: request.clientId
      });
      const callback = new URL(request.redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", request.state);
      return callback.toString();
    },

    /** Refuse an authorization URL as the user would; returns the callback. */
    deny(authUrl: string): string {
      const request = parseAuthorizationUrl(authUrl);
      const callback = new URL(request.redirectUri);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("state", request.state);
      return callback.toString();
    },

    /** The scope an authorization URL asks for. */
    requestedScope(authUrl: string): string | null {
      return new URL(authUrl).searchParams.get("scope");
    },

    /** How many authorization codes the token endpoint was asked to redeem. */
    codeExchanges(): number {
      return tokenRequests.filter(
        (params) => params.get("grant_type") === "authorization_code"
      ).length;
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

    /** How many MCP requests were refused with a plain 403. */
    forbiddenResponses(): number {
      return forbiddenResponses;
    },

    /** How many requests are waiting at the hold right now. */
    waitingRequests(): number {
      return waiting;
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
      registeredClients.length = 0;
      unauthorizedMethods.length = 0;
      options.up = true;
      options.refuseRefresh = false;
      options.refuseCodes = false;
      options.openHandshake = false;
      options.challengeScope = READ_SCOPE;
      options.legacyOnly = false;
      options.forbidden = false;
      options.tokenError = undefined;
      options.staticToken = undefined;
      forbiddenResponses = 0;
      releaseHeld();
      for (const session of sseSessions.values()) {
        try {
          session.close();
        } catch {
          // Already closed by the client.
        }
      }
      sseSessions.clear();
    }
  };
}
