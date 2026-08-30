---
"@cloudflare/channels": minor
---

Add a Web Channel for arbitrary Durable Objects. It speaks the AIChatAgent
browser protocol using an owned WebSockets capability, dispatches incoming
turns through `ChannelHost.onMessage`, and streams `ChannelChunk`s back as AI SDK
UI message chunks.

Push-based Channels can now bind live ingress to the Host's normal routing and
dispatch path. `consumeChunks` also accepts an `AbortSignal` so transports can
cancel active generation safely.
