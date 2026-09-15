---
"agents": minor
---

Let `ChannelHost` record transport-neutral response chunks through an optional `Streams` capability. Recorded responses use caller-supplied response, conversation, and canonical message identities; normalize missing message and part identities before appending and delivery; remain readable from the durable stream cursor; and settle as completed or errored with the source.

Move canonical conversation-history resolution onto `ChannelHost` so Channels can share one query-only resolver while keeping transcript persistence in the application.

Let the Web Channel discover these response streams during the existing resume handshake, replay their durable prefix, and follow their live tail without duplicate delivery. Web correlation and browser-tool ownership remain stream metadata while the recorded chunks stay transport-neutral; canonical transcript snapshots suppress replay once they contain the settled assistant message.
