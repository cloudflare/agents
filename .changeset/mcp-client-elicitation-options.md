---
"agents": patch
---

MCP client: url-mode elicitation support with a real elicitation handler

- Agents can now respond to server-initiated `elicitation/create` requests by
  calling `this.mcp.configureElicitationHandlers({ form, url })`, typically in
  `onStart()`. The advertised modes are persisted with each MCP server, so
  connections restored after Durable Object hibernation re-advertise them at
  the handshake and the handlers re-attach when onStart runs.
  `MCPClientConnection` also accepts `elicitationHandlers` callbacks for
  lower-level non-Agent usage.
- Connections advertise elicitation modes based on what can actually be
  handled: they advertise exactly the modes with configured handlers at the
  initialize handshake; without handlers they advertise no elicitation
  capability. An explicit
  `client.capabilities.elicitation` (e.g. via `addMcpServer`) always wins,
  is persisted with the server options, and survives hibernation — it is no
  longer clobbered by a hardcoded value.
- Overriding/instance-patching `MCPClientConnection.handleElicitationRequest`
  directly is deprecated in favor of the `elicitationHandlers` option.
