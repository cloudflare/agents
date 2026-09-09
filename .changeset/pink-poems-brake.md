---
"@cloudflare/channels": minor
---

Stream outbound messages.

`host.stream(surface, chunks, options?)` takes a
`ReadableStream<ChannelChunk>` and resolves one `DeliveryResult`. Channels that
can stream consume the stream themselves; Channels that cannot never learn it
was a stream, because the Host collects the answer and calls `deliver` once.

- New `ChannelChunk` union covering `text`, `reasoning`, `tool`, and `source`;
  tool chunks can carry a stable invocation ID. `Channel` and
  `OutboundResolver` gain an optional `stream` method.
- New `consumeChunks` helper for Channel authors, which reads a stream to
  completion and then finalizes exactly once, whether it closed or errored.
- Slack streams through `chat.startStream` / `appendStream` / `stopStream`,
  collecting into an ordinary message for top-level channels where Slack does
  not support native streaming. Telegram previews with `sendMessageDraft`
  before persisting the answer with `sendMessage`.
- `fanout` tees the stream per destination and cancels branches whose
  destinations return without consuming them. `fallback` advances after a
  failure only before that destination starts reading, avoiding an unbounded
  replay buffer.
- `toChannelChunks` maps an AI SDK `fullStream` onto `ChannelChunk`.
- `DeliveryResult`'s `uncertain` arm gains an optional `reference`, and the
  three statuses are now defined by what the reader received rather than by
  what the transport accepted. A stream that ends before its answer is complete
  is `uncertain`.

Slack reply surfaces derived from ingress carry `recipientUserId` and
`recipientTeamId`, which distinguishes native-streaming direct messages from
buffered top-level channel delivery and identifies the reader for channel
streams.
