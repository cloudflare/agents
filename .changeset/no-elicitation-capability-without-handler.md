---
"agents": patch
---

MCP client: advertise no elicitation capability when no handler is configured

Connections without an elicitation handler previously advertised form-mode
elicitation while rejecting every elicitation request that arrived, so
spec-compliant servers chose elicitation over their fallback flows and the
tool call failed mid-flight. Connections now advertise the elicitation
capability only when it can be handled: both form and url mode with a
handlers configured via `this.mcp.configureElicitationHandler({ form, url })`
or the connection `elicitationHandlers` option, and no elicitation capability
without handlers, letting servers fall back gracefully. Only modes with
configured handlers are advertised.

Behavior change: code relying on the deprecated pattern of instance-patching
`handleElicitationRequest` on a connection stops receiving elicitation
requests, because the capability is no longer advertised. Migrate to
`this.mcp.configureElicitationHandler({ form, url })` / the connection
`elicitationHandlers` option, or declare
`client.capabilities.elicitation` explicitly — an explicit declaration is
always honored.
