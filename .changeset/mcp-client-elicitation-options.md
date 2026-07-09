---
"agents": patch
---

MCP client: url-mode elicitation support with a real elicitation handler

- Agents can now respond to server-initiated `elicitation/create` requests by
  calling `this.mcp.configureElicitationHandler(handler)` before MCP
  connections are registered or restored. Agent `onStart()` now runs before
  automatic MCP restore, so onStart configuration survives Durable Object
  hibernation and applies to restored connections.
  `MCPClientConnection` also accepts an `elicitationHandler` callback for
  lower-level non-Agent usage.
- Connections advertise elicitation modes based on what can actually be
  handled: with a handler configured they advertise `{ form: {}, url: {} }`
  (MCP spec 2025-11-25) at the initialize handshake; without one they
  advertise no elicitation capability. An explicit
  `client.capabilities.elicitation` (e.g. via `addMcpServer`) always wins,
  is persisted with the server options, and survives hibernation — it is no
  longer clobbered by a hardcoded value.
- Overriding/instance-patching `MCPClientConnection.handleElicitationRequest`
  directly is deprecated in favor of the `elicitationHandler` option.
