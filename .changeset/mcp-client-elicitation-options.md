---
"agents": patch
---

MCP client: url-mode elicitation support with a real elicitation handler

- Agents can now respond to server-initiated `elicitation/create` requests
  by overriding `Agent.onElicitRequest(request, serverId)`. As a class
  method it survives Durable Object hibernation and applies to connections
  restored from storage. `MCPClientManager` also accepts an
  `elicitationHandler` option, and `MCPClientConnection` an
  `elicitationHandler` callback, for non-Agent usage.
- Connections advertise elicitation modes based on what can actually be
  handled: with a handler configured they advertise `{ form: {}, url: {} }`
  (MCP spec 2025-11-25) at the initialize handshake; without one they keep
  the previous form-mode-only default. An explicit
  `client.capabilities.elicitation` (e.g. via `addMcpServer`) always wins,
  is persisted with the server options, and survives hibernation — it is no
  longer clobbered by a hardcoded value.
- Overriding/instance-patching `MCPClientConnection.handleElicitationRequest`
  directly is deprecated in favor of the `elicitationHandler` option.
