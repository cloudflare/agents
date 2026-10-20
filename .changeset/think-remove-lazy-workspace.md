---
"@cloudflare/think": patch
---

Remove `lazyWorkspace`, exported by mistake in 0.21.0. Use `getWorkspace(() => stub)` from `@cloudflare/computer` 0.6, which Think now also accepts as a peer. See [Multi-session chat](https://github.com/cloudflare/agents/blob/main/docs/think/multi-chat.md#share-the-workspace).
