---
"agents": patch
---

Fix MCP OAuth PKCE verifier lookup for overlapping authorization attempts.

`DurableObjectOAuthClientProvider` now binds pending PKCE verifiers to the OAuth callback state instead of storing a single verifier per client/server. Callback handling runs token exchange and verifier cleanup in the returned state's context, so older auth windows and retry churn no longer exchange an authorization code with another attempt's verifier.
