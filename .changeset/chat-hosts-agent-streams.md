---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` no longer construct their own `Streams` capability: `Agent` installs one as `this.streams`, and `ResumableStream` raises the per-chunk ceiling chat needs for its own writes through that shared instance. `this.streams` is still there, now inherited from `Agent`; `createChatStreams()` is deprecated and only for a plain Lifecycle host that installs its own.
