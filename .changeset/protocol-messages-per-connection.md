---
"agents": minor
---

Add `shouldSendProtocolMessages` hook and `isConnectionProtocolEnabled` predicate for per-connection control of protocol text frames

Adds the ability to suppress protocol messages (`CF_AGENT_IDENTITY`, `CF_AGENT_STATE`, `CF_AGENT_MCP_SERVERS`) on a per-connection basis. This is useful for binary-only clients (e.g. MQTT devices) that cannot handle JSON text frames.

Override `shouldSendProtocolMessages(connection, ctx)` to return `false` for connections that should not receive protocol messages. These connections still fully participate in RPC and regular messaging — only the automatic protocol text frames are suppressed, both on connect and during broadcasts.

Use `isConnectionProtocolEnabled(connection)` to check a connection's protocol status at any time.

Also fixes `isConnectionReadonly` to correctly survive Durable Object hibernation by re-wrapping the connection when the in-memory accessor cache has been cleared.
