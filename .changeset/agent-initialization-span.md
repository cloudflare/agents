---
"agents": minor
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Group SDK-managed initialization, startup, chat interactions, turns, and durable submissions into semantic phases. Storage-heavy setup, hydration, recovery, request persistence, and response persistence each receive a named bucket, keeping inference and tool spans visible without discarding lower-level Durable Object SQLite spans. Each span records agent identity, storage phase, a stable marker for UI grouping, and operation-specific metadata. No-op on runtimes without the `tracing` API.
