---
"agents": patch
---

MCP client: advertise no elicitation capability when no handler is configured

Connections without an elicitation handler previously advertised form-mode
elicitation while rejecting every elicitation request that arrived, so
spec-compliant servers chose elicitation over their fallback flows and the
tool call failed mid-flight. Connections now advertise the elicitation
capability only when it can be handled: form mode, URL mode, or both, based on
handlers configured via `this.mcp.configureElicitationHandlers({ form, url })`.
Connections without handlers advertise no elicitation capability, letting
servers fall back gracefully.

An explicit `client.capabilities.elicitation` declaration remains authoritative.
Only advertise modes your Agent can handle.
