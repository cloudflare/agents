---
"agents": minor
---

Support the next Pi release. Pi tools now park with `{ kind: "sleep", signals, until }` instead of `{ sleep: { ... } }`, and a signal's state is `{ kind: "value", value }` or `{ kind: "expired" }`. A tool that still returns the old shape compiles but ends with an empty result, so update parking tools when you upgrade. See [Tools that wait](https://developers.cloudflare.com/agents/harnesses/pi/#tools-that-wait).

On the `agents/models/pi-ai` chat-completions wire, `rawStopReason` now records the provider's finish reason, and OpenRouter models add the upstream provider's `native_finish_reason` to it and to error messages, as pi-ai does; an OpenRouter `stop` with no text or tool calls whose native reason is a failure is now a retryable empty-response error. See [Models for pi-ai](https://developers.cloudflare.com/agents/models/pi-ai/).

`agents/models/pi-ai` now calls `onResponse` for every response, as pi-ai does: a vendor's error response on every wire and AI Gateway's own failures included, so a failed request's status and `retry-after` can be read. See [Models for pi-ai](https://developers.cloudflare.com/agents/models/pi-ai/).
