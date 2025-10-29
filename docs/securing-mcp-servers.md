# Securing MCP Servers

Model Context Protocol servers, like every other web application, need to be secured so they can be used by trusted users without abuse. The MCP spec uses the OAuth 2.1 standard for authentication between MCP clients and servers.

Cloudflare's `workers-oauth-provider` lets you secure your MCP Server (or any application) running on a Cloudflare Worker. The provider handles token management, client registration, and access token validation automatically.

```typescript
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";

// A Worker that exposes an MCP server
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

However, most MCP servers aren't just servers, they can actually be OAuth clients too. Your MCP server might sit between Claude Desktop and a third-party API like GitHub or Google. To Claude, you're a server. To GitHub, you're a client. This allows your users to authenticate and use their GitHub credentials to access your MCP server. We call this a proxy server.

There are a few security footguns to securely building a proxy server. The rest of this document aims to outline best practises to securing an MCP server.

## `redirect_uri` validation

The `workers-oauth-provider` package handles this automatically. It validates that the `redirect_uri` in the authorization request matches one of the registered redirect URIs for the client. This prevents attackers from redirecting authorization codes to their own endpoints.

## Consent dialog

When your MCP server acts as an OAuth proxy to third-party providers (like Google, GitHub, etc.), you must implement your own consent dialog before forwarding users to the upstream authorization server. This prevents the ["confused deputy"](https://en.wikipedia.org/wiki/Confused_deputy_problem) problem where attackers could exploit cached consent from the third-party provider to gain unauthorized access. Your consent dialog should clearly identify the requesting MCP client by name and display the specific scopes being requested. Implementing this consent flow requires thinking about a few security concerns.

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

  // Then redirect to upstream provider and clear the CSRF with the clearCookie header
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

### XSS protection

User-controlled content (client names, logos, URIs) in your approval dialog can execute malicious scripts if not sanitized. Client registration is dynamic, so you must treat all client metadata as untrusted input.

**Required protections:**

- **Client names/descriptions**: HTML-escape all text before rendering (escape `<`, `>`, `&`, `"`, `'`)
- **Logo URLs**: Validate URL scheme (allow only `http:` and `https:`), reject `javascript:`, `data:`, `file:` schemes
- **Client URIs**: Same as logo URLs - whitelist http/https only
- **Scopes**: Treat as text, HTML-escape before display

```typescript
function sanitizeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return ""; // Reject dangerous schemes
    }
    return url;
  } catch {
    return ""; // Invalid URL
  }
}

// Always sanitize before rendering
const clientName = sanitizeText(client.clientName);
const logoUrl = sanitizeText(sanitizeUrl(client.logoUri));
```

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

MCP proxy servers must maintain a registry of approved client IDs per user and check this registry before initiating the third-party authorization flow. Store approved clients in a secure, cryptographically signed cookie with HMAC-SHA256.

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

## Cookies

### Why `__Host-` prefix?

Throughout this document you'll see cookies named with the `__Host-` prefix (like `__Host-CSRF_TOKEN` and `__Host-APPROVED_CLIENTS`). This is especially important for MCP servers running on `*.workers.dev` domains.

The `__Host-` prefix is a security feature that prevents subdomain attacks. When you set a cookie with this prefix:

- It **must** be set with the `Secure` flag (HTTPS only)
- It **must** have `Path=/`
- It **must not** have a `Domain` attribute

This means the cookie is locked to the exact domain that set it. Without `__Host-`, an attacker controlling `evil.workers.dev` could set cookies for your `mcp-server.workers.dev` domain and potentially inject malicious CSRF tokens or approved client lists. The `__Host-` prefix prevents this by ensuring only your specific domain can set and read these cookies.

### Multiple OAuth clients on the same host

If you're running multiple OAuth flows on the same domain (e.g., GitHub OAuth and Google OAuth on the same worker), namespace your cookies to prevent collisions.

Instead of `__Host-CSRF_TOKEN`, use `__Host-CSRF_TOKEN_GITHUB` and `__Host-CSRF_TOKEN_GOOGLE`. Same applies for approved clients: `__Host-APPROVED_CLIENTS_GITHUB` vs `__Host-APPROVED_CLIENTS_GOOGLE`. This ensures each OAuth flow maintains isolated state.

# More info

[MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
[RFC 9700 - Protecting Redirect Based Flows](https://www.rfc-editor.org/rfc/rfc9700#name-protecting-redirect-based-f)
