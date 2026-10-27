---
"@cloudflare/think": patch
---

Remove `lazyWorkspace`, exported by mistake in 0.21.0. Use `getWorkspace(() => stub)` from `@cloudflare/computer` instead. Think's `@cloudflare/computer` peer is now `^0.8.0`, so upgrade Computer to 0.8 alongside Think. See [Multi-session chat](https://github.com/cloudflare/agents/blob/main/docs/think/multi-chat.md#share-the-workspace).
