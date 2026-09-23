---
"@cloudflare/think": patch
---

Recovery continuations now extend the interrupted assistant message instead of appending a second one. When a turn was interrupted by an eviction, a deploy, or a stream stall, the continuation streamed into a fresh assistant message, so one answer was split across two messages in the transcript and in later model context. The continuation now reuses the interrupted message's id, parts, and metadata, and closes any text or reasoning part the interruption left streaming. A direct `continueLastTurn()` call still persists its response as a separate assistant message, as documented.
