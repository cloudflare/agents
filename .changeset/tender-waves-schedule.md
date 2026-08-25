---
"agents": minor
"@cloudflare/think": patch
---

Add `Scheduler`, a reusable Lifecycle capability for persistent delayed, dated, cron, and interval callbacks, under `agents/schedules`. `LifecycleCapability` supplies every capability with storage, readiness, alarm coordination, best-effort events, and generic capability routing. Lifecycle owns the physical Durable Object alarm and routes matching capability messages between Agent facets through one internal transport aperture, preserving existing root-owned facet schedule rows without Scheduler-specific Agent RPC methods or an Agent adapter. `Agent` uses the same Scheduler behind its existing APIs and preserves callback context, observability, retries, OOM handling, and alarm behavior. MCP now receives storage from Lifecycle when installed. Explicit destruction disposes live capability resources once, then clears shared Durable Object storage with `deleteAll()`. Think workflow notifications now contribute their wake time through Lifecycle instead of writing the physical alarm directly. The previous `agents/schedule` parser entry point remains as a deprecated compatibility alias.
