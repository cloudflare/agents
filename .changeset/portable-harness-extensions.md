---
"agents": patch
---

Add `agents/harness/extensions` (experimental): one extension format for every harness. Extensions are code: `defineExtension({ id, setup })` registers transforms over the `tool`, `instructions` and `skill` domains, which rebuild from scratch on every reload, and `execute.before`/`execute.after` hooks on tool calls. `piExtensions()` from `agents/harness/pi` runs them on `PiHarness`.
