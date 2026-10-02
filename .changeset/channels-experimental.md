---
"agents": minor
---

Breaking: remove the first pass of `agents/channels` and move Channels to `agents/experimental/channels`.

The `agents/channels` entry points are gone, along with `ChannelHost`, the `fallback` and `fanout` composites, and the AI SDK, TanStack AI and Voice helpers from the first pass. Slack, Telegram and Email move to `agents/experimental/channels/slack`, `agents/experimental/channels/telegram` and `agents/experimental/channels/email`, and keep verified ingress and normalization. Channels is being rebuilt around conversations and turns; the new API is experimental and may change between releases.
