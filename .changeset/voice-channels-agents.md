---
"agents": minor
---

Move Voice and Channels into explicit Agents subpath exports.

Voice is available from `agents/voice` with isolated `types`, `client`, `react`,
`errors`, `workers-ai`, `sfu`, and `text` entries. Channels is available from
`agents/channels` with separate email, Slack, Telegram, browser Voice, AI SDK,
and TanStack AI adapters.

Channels includes streamed outbound delivery through `ChannelHost.stream()`,
provider-native Slack and Telegram streaming, fallback and fanout stream
handling, and AI SDK stream conversion.
