# Securing MCP Servers

MCP servers, like any web application, need to be secured so they can be used by trusted users without abuse. The MCP specification uses OAuth 2.1 for authorization between MCP clients and servers.

[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) handles client registration, tokens, and token validation. `OAuthProvider` runs the authorization server and your MCP server in one Worker:

```typescript
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";

function createServer() {
  return new McpServer({ name: "authenticated-server", version: "1.0.0" });
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  apiRoute: "/mcp", // Protected MCP endpoint
  apiHandler: {
    // OAuthProvider needs an object with a fetch method
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    }
  },

  defaultHandler: AuthHandler, // Your /authorize page

  // The URL MCP clients connect to. Every token is bound to it.
  resourceMetadata: { resource: env.MCP_RESOURCE }
});
```

Tool callbacks receive the `props` you stored at sign-in through `getMcpAuthContext().props`, and the verified token's client and scopes through `context.http.authInfo`. Treat `authInfo.token` and `authInfo.extra.props` as sensitive: do not log or return them.

The library secures the token side. Your `/authorize` page is application code, and it is where most MCP security mistakes happen. The rest of this page covers the library APIs that make it safe.

## Consent page

Every MCP client can register itself, so your `/authorize` page must ask the user whether this client may act for them before calling `completeAuthorization()`. The page must show the client's name, the scopes, and the hostname the tokens will be sent to, and it must not be possible to frame or forge it.

| API                                                   | What it does                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describeConsent(request)`                            | Returns what the page must show: `clientName`, `clientDomain` (the verified domain of a Client ID Metadata Document client), `redirectHost`, `redirectIsLoopback`, and `scope`.                           |
| `beginConsent(request)`                               | Stores the authorization request on the server and returns a single-use `handle` for your form, plus `headers` to send with the page. The headers set a browser-bound `__Host-` cookie and block framing. |
| `approveConsent(request, handle, options?)`           | Checks the handle against the cookie and returns the stored authorization request. Pass `scope` with the scopes the user approved.                                                                        |
| `denyConsent(request, handle)`                        | Returns headers that redirect the user back to the client with `access_denied`.                                                                                                                           |
| `isConsentRemembered(request, authRequest, remember)` | Returns `true` if the user already approved this client, redirect URI, and scopes. Pass `remember` to `approveConsent()` to record an approval.                                                           |

```typescript
const oauth = env.OAUTH_PROVIDER;

// GET /authorize, after signing the user in
const authRequest = await oauth.parseAuthRequest(request);
const details = await oauth.describeConsent(authRequest);
const consent = await oauth.beginConsent(authRequest);
consent.headers.set("Content-Type", "text/html; charset=utf-8");
return new Response(consentPage(details, consent.handle), {
  headers: consent.headers
});

// POST /authorize
const form = await request.formData();
const handle = String(form.get("handle"));
if (form.get("decision") !== "approve") {
  const denied = await oauth.denyConsent(request, handle);
  return new Response(null, { status: 302, headers: denied.headers });
}
const approved = await oauth.approveConsent(request, handle, {
  scope: form.getAll("scope").map(String)
});
const { redirectTo } = await oauth.completeAuthorization({
  request: approved.request, // from storage, not from the form
  userId: session.userId,
  metadata: {},
  scope: approved.request.scope,
  props: { userId: session.userId }
});
approved.headers.set("Location", redirectTo);
return new Response(null, { status: 302, headers: approved.headers });
```

The form carries only the handle. The authorization request stays on the server, so a forged form cannot approve a different client or redirect URI.

`describeConsent()` returns the values but does not render HTML, and every string in it can come from the client. Render them with a template or JSX library that escapes output, such as Hono's JSX.

See [Building a consent page](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md) for a complete page and for which errors to redirect back to the client and which to render on your page.

## Signing in through a third-party provider

Many MCP servers sign users in with GitHub, Google, or another provider and call that provider's API with the user's token. Every MCP client then reaches the provider through your one OAuth app. This is the [confused deputy problem](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#confused-deputy-problem): without per-client consent, an attacker's client can ride on a user's earlier approval at the provider.

Ask for consent first, then hand the user to the provider:

| API                                   | What it does                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beginUpstream(authRequest, options)` | Call after `approveConsent()`. Stores the authorization request and your `data` (for example, a PKCE verifier), and returns a `state` value for the provider redirect, bound to the user's browser by a `__Host-` cookie. |
| `finishUpstream(request)`             | Call in your callback. Checks `state` against the cookie and returns the original authorization request and your `data`. A provider code replayed in another browser is rejected.                                         |
| `tokenExchangeCallback`               | An `OAuthProvider` option that runs on token refresh. Refresh the provider's token there, and throw `new OAuthError("invalid_grant", { description })` when the provider has revoked access.                              |

```typescript
// POST /authorize: the user approved this client
const approved = await oauth.approveConsent(request, handle);
const { state, headers } = await oauth.beginUpstream(approved.request, {
  data: { verifier }, // returned at the callback, never sent to the provider
  headers: approved.headers
});
headers.set("Location", providerAuthorizeUrl({ state }));
return new Response(null, { status: 302, headers });

// GET /callback
const {
  request: original,
  data,
  headers: clear
} = await oauth.finishUpstream<{ verifier: string }>(request);
const upstream = await exchangeProviderCode(
  new URL(request.url).searchParams.get("code")!,
  data.verifier
);
const { redirectTo } = await oauth.completeAuthorization({
  request: original,
  userId: upstream.userId,
  metadata: {},
  scope: original.scope,
  props: { providerToken: upstream.accessToken } // encrypted at rest
});
clear.set("Location", redirectTo);
return new Response(null, { status: 302, headers: clear });
```

See [Signing in through another provider](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md) for the full flow.

## Checks on the MCP server

`OAuthProvider` accepts only tokens issued for `resourceMetadata.resource`, so keep `MCP_RESOURCE` exactly the URL clients connect to.

Scopes are not enforced for you. Check them before handling a request, and return `insufficientScope()` when one is missing so the client can ask the user for it (step-up authorization):

```typescript
import {
  insufficientScope,
  type OAuthResourceContext
} from "@cloudflare/workers-oauth-provider";

type Props = { userId: string }; // what you passed to completeAuthorization()

apiHandler: {
  fetch(request: Request, env: Env, ctx: OAuthResourceContext<Props>) {
    if (!ctx.auth.scope.includes("mcp:read")) {
      return insufficientScope(ctx.auth, ["mcp:read"]);
    }
    return mcpHandler(request, env, ctx);
  }
},
```

## Security checklist

| Protection                                          | Provided by                                    |
| --------------------------------------------------- | ---------------------------------------------- |
| Per-client consent before `completeAuthorization()` | `beginConsent()`, `approveConsent()`           |
| Consent form cannot be framed or forged             | `beginConsent()` headers and single-use handle |
| Client metadata escaped on the consent page         | Your page template                             |
| Provider `state` bound to the browser               | `beginUpstream()`, `finishUpstream()`          |
| Tokens accepted only for this MCP server            | `OAuthProvider` and `resourceMetadata`         |
| Scopes checked for each operation                   | Your handler, with `insufficientScope()`       |

# More info

- [Workers OAuth Provider documentation](https://github.com/cloudflare/workers-oauth-provider#readme)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
