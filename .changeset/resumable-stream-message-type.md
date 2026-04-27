---
"agents": patch
---

Add a `messageType` constructor option to `ResumableStream` so non-chat consumers (e.g. helper sub-agents that share a WebSocket with a parent's chat) can stamp replay frames with a distinct wire-type tag. Defaults to `CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE`, so existing `AIChatAgent` and `Think` callers preserve byte-identical behavior. Also exports the new `ResumableStreamOptions` type.

This is the smaller version of the fix proposed in [#1377](https://github.com/cloudflare/agents/issues/1377): the `tablePrefix` option from that proposal is intentionally omitted because the recommended pattern for "events alongside a chat" is now to put helper events on the helper sub-agent's own DO (so collisions are impossible by isolation). See `wip/inline-sub-agent-events.md` for the full design.
