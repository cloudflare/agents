---
"agents": patch
---

`McpAgent.elicitInput` now accepts an optional `options.relatedRequestId`, forwarded to the underlying transport so the elicitation request routes through the originating POST response stream per the Streamable HTTP spec. Callers should pass `{ relatedRequestId: extra.requestId }` from inside a tool handler.
