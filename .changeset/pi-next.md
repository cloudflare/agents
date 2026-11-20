---
"agents": minor
---

Support Pi 1.6 (`~1.6.0`; Pi 1.5 is no longer supported). `harness.signal()` delivers a signal to a parked Pi tool. `PiSession.submit()` and `continue()` take `notify`, so a parked tool can wake when another session's input settles, and `submit()` takes `onAbort: "keep"`, so a queued input stays queued when the session is aborted. `agents/models/pi-ai` counts reasoning and cached tokens that a chat-completions vendor reports at the top level of `usage`, as pi-ai does, and resends a conversation in full when Anthropic can no longer continue its message thread, instead of failing the turn. See [pi-durable 1.6.0's changelog](https://github.com/earendil-works/pi/blob/v1.6.0/packages/durable/CHANGELOG.md#160---2026-11-20) and [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
