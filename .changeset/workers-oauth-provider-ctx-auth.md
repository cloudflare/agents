---
"agents": patch
---

`createMcpHandler` now reads the verified token that `@cloudflare/workers-oauth-provider` 1.x sets as `ctx.auth`, so tool callbacks receive `context.http.authInfo` (token, client ID, scopes, expiry and resource) behind `OAuthProvider` and `OAuthResourceServer`. `getMcpAuthContext().props` is unchanged.
