---
"agents": minor
---

Support Pi 1.6 (`~1.6.0`; Pi 1.5 is no longer supported): `PiSession.submit()` takes `notify`, so a parked Pi tool can wake when an input to another session settles, and `onAbort: "keep"`, so a queued input stays queued when the session is aborted; `agents/models/pi-ai` counts reasoning tokens that a chat-completions vendor reports as a top-level `usage.reasoning_tokens`, as pi-ai does. See [pi-durable 1.6.0's changelog](https://github.com/earendil-works/pi/blob/v1.6.0/packages/durable/CHANGELOG.md#160---2026-11-20) and [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
