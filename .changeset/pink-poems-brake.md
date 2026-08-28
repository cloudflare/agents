---
"@cloudflare/channels": minor
---

Stream outbound messages.

`host.stream(surface, chunks, options?)` takes a
`ReadableStream<ChannelChunk>` and resolves one `DeliveryResult`. Channels that
can stream consume the stream themselves; Channels that cannot never learn it
was a stream, because the Host collects the answer and calls `deliver` once.

- New `ChannelChunk` union covering `text`, `reasoning`, `tool`, and `source`,
  plus an optional `stream` method on `Channel` and `OutboundResolver`.
- New `consumeChunks` helper for Channel authors, which reads a stream to
  completion and then finalizes exactly once, whether it closed or errored.
- Slack streams through `chat.startStream` / `appendStream` / `stopStream`,
  collecting into an ordinary message for top-level channels where Slack does
  not support native streaming. Telegram previews with `sendMessageDraft`
  before persisting the answer with `sendMessage`.
- `fanout` tees the stream per destination; `fallback` buffers consumed chunks
  and replays them to the next destination after a failure.
- `toChannelChunks` maps an AI SDK `fullStream` onto `ChannelChunk`.
- `DeliveryResult`'s `uncertain` arm gains an optional `reference`, and the
  three statuses are now defined by what the reader received rather than by
  what the transport accepted. A stream that ends before its answer is complete
  is `uncertain`.

Slack reply surfaces derived from ingress now carry `recipientUserId` and
`recipientTeamId` for non-direct messages, which Slack requires to stream into
a channel.
