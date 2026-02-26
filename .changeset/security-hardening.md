---
"agents": patch
---

Security hardening for Agent and MCP subsystems:

- **SSRF protection**: MCP client now validates URLs before connecting, blocking private/internal IP addresses (RFC 1918, loopback, link-local, cloud metadata endpoints, IPv6 unique local and link-local ranges)
- **OAuth log redaction**: Removed OAuth state parameter value from `consumeState` warning logs to prevent sensitive data leakage
- **Error sanitization**: MCP server error strings are now sanitized (control characters stripped, truncated to 500 chars) before broadcasting to clients to mitigate XSS risk
- **Deprecation warnings**: Added one-time warnings for `sendIdentityOnConnect` (default `true` will change to `false` in next major) and CORS `Authorization` header with wildcard origin (will be removed from defaults in next major)
