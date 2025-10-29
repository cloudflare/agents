# Securing MCP Servers

The Model Context Protocol is still in it's early stages. Over the last few months it has adopted the Oauth2.1 standard for authentication between MCP clients and servers.

Cloudflare introduced the `workers-oauth-provider` which allows you to secure your MCP Server (or any application) running on a Cloudflare Worker. The provider handles token management, client registration, and access token validation automatically.

```typescript
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";

// Your MCP server with tools
const apiHandler = {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return createMcpHandler(server)(request, env, ctx);
  }
};

// Wrap with OAuth protection
export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  apiRoute: "/mcp", // Protected MCP endpoint
  apiHandler: apiHandler, // Your MCP server

  defaultHandler: AuthHandler // Handles consent flow
});
```

However in most MCP Servers, the MCP Server will actually act as both a server to the MCP client, like Claude Desktop, and as an Oauth2 client to a 3rd party authentication provider such as Google, Github, etc. We call this a proxy server as it act as both a server and a client.

There are a few footguns to securely building a proxy MCP Server. The rest of this document aims to outline the best practises.

## Consent dialog

When your MCP server acts as an OAuth proxy to third-party providers (like Google, GitHub, etc.), you must implement your own consent dialog before forwarding users to the upstream authorization server. This prevents the "confused deputy" problem where attackers could exploit cached consent from the third-party provider to gain unauthorized access. Your consent dialog should clearly identify the requesting MCP client by name and display the specific scopes being requested. Implementing this consent flow requires thinking about a few security concerns.

### CSRF Protection

Without CSRF protection, an attacker can trick users into approving malicious OAuth clients. Use a random token stored in a secure cookie and validate it on form submission.

```typescript
// GET /authorize - Generate CSRF token when showing consent form
app.get("/authorize", async (c) => {
  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken, // Pass to form as hidden field
    setCookie // Set the cookie
    // ... other dialog data
  });
});

// POST /authorize - Validate CSRF token when user approves
app.post("/authorize", async (c) => {
  const formData = await c.req.raw.formData();

  // Validate CSRF token exists and matches cookie
  const { clearCookie } = validateCSRFToken(formData, c.req.raw);

  // Proceed with authorization flow...
  // Redirect to upstream provider and clear the CSRF with the clearCookie header
});

// Helper functions
function generateCSRFProtection(): CSRFProtectionResult {
  const token = crypto.randomUUID();
  const setCookie = `__Host-CSRF_TOKEN=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
  return { token, setCookie };
}

function validateCSRFToken(
  formData: FormData,
  request: Request
): ValidateCSRFResult {
  const tokenFromForm = formData.get("csrf_token");
  const cookieHeader = request.headers.get("Cookie") || "";
  const tokenFromCookie = cookieHeader
    .split(";")
    .find((c) => c.trim().startsWith("__Host-CSRF_TOKEN="))
    ?.split("=")[1];

  if (!tokenFromForm || !tokenFromCookie || tokenFromForm !== tokenFromCookie) {
    throw new OAuthError("invalid_request", "CSRF token mismatch", 400);
  }

  // Clear cookie after use (one-time use per RFC 9700)
  return {
    clearCookie: `__Host-CSRF_TOKEN=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`
  };
}
```

Include the token as a hidden field in your consent form:

```html
<input type="hidden" name="csrf_token" value="${csrfToken}" />
```

### redirect_uri validation

The `workers-oauth-provider` handles this automatically. It validates that the redirect_uri in the authorization request matches one of the registered redirect URIs for the client. This prevents attackers from redirecting authorization codes to their own endpoints.

### XSS protection

User-controlled content (client names, logos, URIs) in your approval dialog can execute malicious scripts if not sanitized. Always escape HTML and validate URLs.

### Clickjacking protection

Attackers can embed your approval dialog in an invisible iframe and trick users into clicking. Prevent this with Content Security Policy headers.

```typescript
return new Response(htmlContent, {
  headers: {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY", // Legacy browser support
    "Content-Type": "text/html; charset=utf-8",
    "Set-Cookie": setCookie
  }
});
```

## Managing State in KV

Between the consent dialog and the callback there is a gap where the user could do something nasty. We need to make sure it is the same user that hits authorize and then reaches back to our callback. Use a random state token stored server-side in KV with a short expiration time.

```typescript
// Use in POST /authorize - after CSRF validation, before redirecting to upstream provider
async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace
): Promise<{ stateToken: string }> {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
    expirationTtl: 600 // 10 minutes
  });
  return { stateToken };
}

// Use in GET /callback - validate state from query params before exchanging code
async function validateOAuthState(
  request: Request,
  kv: KVNamespace
): Promise<{ oauthReqInfo: AuthRequest }> {
  const stateFromQuery = new URL(request.url).searchParams.get("state");
  if (!stateFromQuery) {
    throw new OAuthError("invalid_request", "Missing state parameter", 400);
  }

  const storedDataJson = await kv.get(`oauth:state:${stateFromQuery}`);
  if (!storedDataJson) {
    throw new OAuthError("invalid_request", "Invalid or expired state", 400);
  }

  await kv.delete(`oauth:state:${stateFromQuery}`); // One-time use
  return { oauthReqInfo: JSON.parse(storedDataJson) };
}
```

Alternatively, you can store a SHA-256 hash of the state in a `__Host-CONSENTED_STATE` cookie if you want to avoid KV, but since most MCP servers will be using the `OAuthProvider` class from `workers-oauth-provider` we can plug into the same `env.OAUTH_KV` binding for state management.

## Approved client

MCP proxy servers must maintain a registry of approved client IDs per user and check this registry before initiating the third-party authorization flow. This prevents attackers from exploiting the confused deputy problem by forcing users through repeated authorization flows. Store approved clients in a secure, cryptographically signed cookie with HMAC-SHA256.

```typescript
// Use in POST /authorize - after user approves, add client to approved list
export async function addApprovedClient(
  request: Request,
  clientId: string,
  cookieSecret: string
): Promise<string> {
  const existingApprovedClients =
    (await getApprovedClientsFromCookie(request, cookieSecret)) || [];
  const updatedApprovedClients = Array.from(
    new Set([...existingApprovedClients, clientId])
  );

  const payload = JSON.stringify(updatedApprovedClients);
  const signature = await signData(payload, cookieSecret); // HMAC-SHA256
  const cookieValue = `${signature}.${btoa(payload)}`;

  return `__Host-APPROVED_CLIENTS=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000`;
}
```

When reading the cookie in GET /authorize (before showing the consent dialog), verify the signature before trusting the data. If the signature doesn't match or the client isn't in the list, show the consent dialog. If the client is approved, skip the dialog and proceed directly to creating the OAuth state.

## Misc

### Why `__Host-` prefix?

Throughout this document you'll see cookies named with the `__Host-` prefix (like `__Host-CSRF_TOKEN` and `__Host-APPROVED_CLIENTS`). This is especially important for MCP servers running on `*.workers.dev` domains.

The `__Host-` prefix is a security feature that prevents subdomain attacks. When you set a cookie with this prefix:

- It **must** be set with the `Secure` flag (HTTPS only)
- It **must** have `Path=/`
- It **must not** have a `Domain` attribute

This means the cookie is locked to the exact domain that set it. Without `__Host-`, an attacker controlling `evil.workers.dev` could set cookies for your `mcp-server.workers.dev` domain and potentially inject malicious CSRF tokens or approved client lists. The `__Host-` prefix prevents this by ensuring only your specific domain can set and read these cookies.

# More info

[Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
[Protecting Redirect Based Flows](https://www.rfc-editor.org/rfc/rfc9700#name-protecting-redirect-based-f)
