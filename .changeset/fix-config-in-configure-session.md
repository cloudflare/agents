---
"@cloudflare/think": patch
---

Fix `getConfig()` throwing "no such table: assistant_config" when called inside `configureSession()`

The config storage helpers (`getConfig`, `configure`) now lazily ensure the `assistant_config` table exists before querying it, so they are safe to call at any point in the agent lifecycle — including during `configureSession()`.
