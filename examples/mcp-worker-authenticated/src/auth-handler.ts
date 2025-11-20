import type {
  AuthRequest,
  OAuthHelpers
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /authorize - OAuth authorization endpoint
 *
 * This endpoint is called when an MCP client wants to authorize.
 * In a full implementation, this would:
 * 1. Parse the OAuth request
 * 2. Check if the client is already approved (via cookie)
 * 3. Show an approval dialog or redirect to external OAuth provider
 */
app.get("/authorize", async (c) => {
  const oauthReqInfo: AuthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(
    c.req.raw
  );
  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(
    oauthReqInfo.clientId
  );

  if (!clientInfo) {
    return c.text("Invalid client_id", 400);
  }

  // For this demo, we'll show a simple HTML approval page
  // In a real implementation, you might:
  // - Check cookies to see if this client was previously approved
  // - Redirect to an external OAuth provider (GitHub, Google, etc.)
  // - Show a custom approval UI
  const approvalPage = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Authorize ${clientInfo.clientName || "MCP Client"}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            line-height: 1.6;
          }
          .card {
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 30px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          }
          h1 { margin-top: 0; }
          .client-info {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
          }
          .actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
          }
          button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
          }
          .approve {
            background: #0070f3;
            color: white;
            flex: 1;
          }
          .deny {
            background: #eee;
            color: #333;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Authorization Request</h1>
          <p><strong>${clientInfo.clientName || "An MCP Client"}</strong> is requesting access to the MCP server.</p>

          <div class="client-info">
            <p><strong>Client ID:</strong> ${clientInfo.clientId}</p>
            ${clientInfo.clientUri ? `<p><strong>Website:</strong> <a href="${clientInfo.clientUri}" target="_blank">${clientInfo.clientUri}</a></p>` : ""}
            <p><strong>Requested Scopes:</strong> ${oauthReqInfo.scope.join(", ") || "none"}</p>
          </div>

          <p>If you approve, this client will be able to:</p>
          <ul>
            <li>Access MCP tools on your behalf</li>
            <li>Receive your authenticated user information</li>
          </ul>

          <form method="POST" action="/authorize">
            <input type="hidden" name="state" value="${btoa(JSON.stringify(oauthReqInfo))}">
            <div class="actions">
              <button type="button" class="deny" onclick="window.history.back()">Cancel</button>
              <button type="submit" class="approve">Approve</button>
            </div>
          </form>
        </div>
      </body>
    </html>
  `;

  return c.html(approvalPage);
});

/**
 * POST /authorize - Handle authorization approval
 *
 * This endpoint is called when the user approves the authorization.
 * It completes the OAuth flow by creating a grant and redirecting back to the client.
 */
app.post("/authorize", async (c) => {
  const formData = await c.req.formData();
  const state = formData.get("state");

  if (!state || typeof state !== "string") {
    return c.text("Missing state parameter", 400);
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(state));
  } catch {
    return c.text("Invalid state parameter", 400);
  }

  // For this demo, we'll use a static user ID
  // In a real implementation, you would:
  // 1. Have already authenticated the user (via external OAuth, session, etc.)
  // 2. Use their actual user ID and profile information
  const userId = "demo-user";
  const userProfile = {
    userId: "demo-user",
    username: "Demo User",
    email: "demo@example.com"
  };

  // Complete the authorization by creating a grant
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: userId,
    metadata: {
      label: "MCP Server Access",
      clientName:
        (await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId))
          ?.clientName || "Unknown Client"
    },
    scope: oauthReqInfo.scope,
    props: userProfile
  });

  // Redirect back to the client with the authorization code
  return c.redirect(redirectTo, 302);
});

/**
 * GET / - Home page
 *
 * Shows information about the OAuth server
 */
app.get("/", (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MCP OAuth Server</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 800px;
            margin: 50px auto;
            padding: 20px;
            line-height: 1.6;
          }
          h1 { color: #0070f3; }
          .endpoint {
            background: #f5f5f5;
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
            font-family: monospace;
          }
        </style>
      </head>
      <body>
        <h1>MCP OAuth Server</h1>
        <p>This is an authenticated MCP server that uses OAuth 2.1 for authorization.</p>

        <h2>Available Endpoints</h2>
        <div class="endpoint">/mcp - MCP server endpoint (requires Bearer token)</div>
        <div class="endpoint">/authorize - OAuth authorization endpoint</div>
        <div class="endpoint">/token - OAuth token endpoint</div>
        <div class="endpoint">/register - Client registration endpoint</div>
        <div class="endpoint">/.well-known/oauth-authorization-server - OAuth metadata</div>

        <h2>Getting Started</h2>
        <p>To connect to this MCP server:</p>
        <ol>
          <li>Register your MCP client via the <code>/register</code> endpoint</li>
          <li>Initiate the OAuth flow by redirecting to <code>/authorize</code></li>
          <li>Exchange the authorization code for an access token at <code>/token</code></li>
          <li>Use the access token to access the <code>/mcp</code> endpoint</li>
        </ol>
      </body>
    </html>
  `);
});

export { app as AuthHandler };
