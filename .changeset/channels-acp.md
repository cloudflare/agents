---
"agents": patch
---

Add `AcpChannel` (`agents/experimental/channels/acp`), which serves a Channels agent to [Agent Client Protocol](https://agentclientprotocol.com) clients such as Zed and T3 Code, and `npx agents acp <url>`, which bridges an ACP client's stdio to the channel's WebSocket.

Each ACP session is a conversation. The channel supports `session/new`, `load`, `resume`, `list`, `close` and `fork`. It streams text, reasoning and tool calls as session updates, turns approvals into `session/request_permission`, and cancels the running turn on `session/cancel`. Messages sent from other surfaces show up in the ACP client too.

`acp()` is its side in the gateway, like `web()` for the Web Channel: it takes `/acp` upgrades by default and resolves who is connecting. The gateway now names the Channel that took an upgrade in the connection identity (`channel`), so the agent's channel mounted under the same key serves it, and the Web Channel ignores connections addressed to another channel.
