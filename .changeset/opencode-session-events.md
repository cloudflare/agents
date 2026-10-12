---
"agents": patch
---

`OpenCodeHarness`: `session.events()` now returns a stream with a snapshot of the session and then its events, translated into the same kinds `PiHarness` reports: `run_start`/`run_end`, `operation_start`/`operation_end` (with the result `wait()` returns), `message_start`/`message_end`, `text_delta`, `reasoning_delta`, `tool_start`/`tool_end`, permissions and compaction. It replaces the async iterable of OpenCode's raw events; those are still available, durable and resumable, from `session.log()`. The OpenCode example now gives the model Workspace tools from `@cloudflare/computer` in place of OpenCode's local file and shell tools.
