---
"agents": patch
---

Revert the Streamable HTTP server-to-client MCP routing change from PR #1514, which routed related messages such as elicitation requests over the originating POST response when no standalone SSE stream was open.
