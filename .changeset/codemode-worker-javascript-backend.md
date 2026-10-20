---
"@cloudflare/codemode": minor
---

`@cloudflare/codemode` now exports `WorkerJavaScriptBackend`, the JavaScript backend from `@cloudflare/computer`. It runs an ES module in a fresh Dynamic Worker, with `node:fs` backed by files you provide and host modules (`ws:*`) that run in your Durable Object. Connect it with SQLite and a filesystem and it runs without Computer. Computer will build on it.

The rest of the package is now the legacy Code Mode API. It moved to `src/legacy` and is re-exported from the same entry points, so existing imports keep working unchanged. It is feature-frozen and no longer maintained, and every export is marked `@deprecated`. See [The legacy Code Mode API](https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md).
