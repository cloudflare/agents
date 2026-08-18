---
"@cloudflare/codemode": patch
---

Add a `transformResult` hook to `codeMcpServer` so callers can replace oversized structured results with complete, bounded envelopes before MCP response formatting and truncation.
