---
"agents": patch
---

Security hardening for Agent and MCP subsystems:

- **SSRF protection**: MCP client now validates URLs before connecting, blocking private/internal IP addresses (RFC 1918, loopback, link-local, cloud metadata endpoints, IPv6 unique local and link-local ranges)
- **OAuth log redaction**: Removed OAuth state parameter value from `consumeState` warning logs to prevent sensitive data leakage
- **Error sanitization**: MCP server error strings are now sanitized (control characters stripped, truncated to 500 chars) before broadcasting to clients to mitigate XSS risk
- **`sendIdentityOnConnect` warning**: When using custom routing (where the instance name is not visible in the URL), a one-time console warning now informs developers that the instance name is being sent to clients. Set `static options = { sendIdentityOnConnect: false }` to opt out, or `true` to silence the warning.
