---
"@cloudflare/think": patch
---

`runTurn({ mode: "wait" })` returns the assistant message from its own turn, even if other turns persist in the meantime. See [Programmatic submissions](https://github.com/cloudflare/agents/blob/main/docs/think/programmatic-submissions.md).
