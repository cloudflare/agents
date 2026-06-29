---
"@cloudflare/think": patch
---

Preserve attachment `fetchMetadata` through messenger event serialization so sub-agents can re-fetch files.

When a conversation resolver routes a thread to a sub-agent Durable Object, the messenger event is run through `serializableMessengerEvent()` before crossing the DO boundary. That serialization previously dropped everything except `id`, `mediaType`, `name`, `size`, `text`, and `url` from each attachment — discarding `fetch`, `raw`, and (for adapters that store their platform identifier there) the only remaining handle on the file.

For adapters like `@chat-adapter/telegram`, the file identifier lives exclusively in `fetchMetadata.fileId` and the top-level `id` is never populated, so photos became irretrievable inside a sub-agent (`attachment.id` and `attachment.fetch` were both missing).

`MessengerAttachment` now carries a serialization-safe `fetchMetadata?: Record<string, string>` field that survives the sub-agent hop. `toMessengerAttachment()` copies `fetchMetadata` from the underlying Chat SDK attachment and backfills the top-level `id` from a known metadata key (`id`, `fileId`, `mediaId`, `fileUniqueId`) when the adapter doesn't set one. A downstream agent can use `fetchMetadata` together with the adapter's `rehydrateAttachment()` to reconstruct the download closure.
