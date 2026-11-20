---
"agents": minor
---

Support Pi 1.6 (`~1.6.0`; Pi 1.5 is no longer supported). Pi 1.6 stores tool calls and model requests in versions Pi 1.5 cannot run, so roll forward rather than back to an `agents` version on Pi 1.5. Code that uses pi-durable directly must follow its breaking changes (`RunEndTask` is `HookTask`, a tool's `execute()` may return a park, code-mode namespaces come from `Extension.namespace`). See [pi-durable 1.6.0's changelog](https://github.com/earendil-works/pi/blob/v1.6.0/packages/durable/CHANGELOG.md#160---2026-11-20) and [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
