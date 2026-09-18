---
"agents": minor
---

Expand `ChannelChunk` with message and part boundaries, structured tool inputs and outputs, files, metadata, and application data. Add AI SDK UI-message stream conversion through the same channel stream contract. Slack and Telegram can now project selected tool status and provider-exposed reasoning into streamed messages through `renderParts`; text-only behavior and existing provider defaults remain available.

Add client-tool definitions on inbound messages and routed `tool-result` events with explicit success/error results. Applications remain responsible for validating pending tool calls and deciding when to continue generation. This does not migrate Think's WebSocket handlers.
