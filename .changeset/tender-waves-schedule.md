---
"agents": minor
"@cloudflare/think": patch
---

Add `Scheduler`, a reusable Lifecycle primitive for persistent delayed, dated, cron, and interval callbacks, under `agents/schedules`. Lifecycle now owns the physical Durable Object alarm and selects it from capability and host contributions, allowing future Fiber and MCP capabilities to keep independent durable state without depending on Scheduler. `Agent` uses the same Scheduler behind its existing APIs and preserves callback context, sub-agent routing, observability, retries, OOM handling, and alarm behavior. Think workflow notifications now contribute their wake time through Lifecycle instead of writing the physical alarm directly. The previous `agents/schedule` parser entry point remains as a deprecated compatibility alias.
