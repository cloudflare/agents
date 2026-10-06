---
"agents": patch
---

Add `agents/harness/extensions` (experimental): one extension format for every harness. An extension is a function of its context. It can add tools (including deferred tools a session activates), hook tool calls (edit, block, or ask the user), set system prompt sections, add skills and slash commands, observe session events, keep durable state with `ctx.storage`, and drive sessions. Transforms rebuild from scratch on every reload. `PiHarness` takes them as `extensions`, hands its factory the `registry` to open pi with, and adds `commands()`, `requests()`, `reply()` and `extensions()`.
