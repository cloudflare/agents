---
"agents": patch
---

Replace console.log-based observability with `node:diagnostics_channel`. Events are now published to named channels (`agents:state`, `agents:rpc`, `agents:message`, `agents:schedule`, `agents:lifecycle`, `agents:workflow`, `agents:mcp`) instead of being logged to the console. This eliminates logspam — publishing to a channel with no subscribers is a no-op. In production, all published messages are automatically forwarded to Tail Workers via `event.diagnosticsChannelEvents`.
