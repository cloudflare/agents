---
"agents": patch
---

`agents/models/pi-ai`: an `onResponse` that throws an `AbortError` on a failed Anthropic response now ends the stream `aborted`, as on the other wires, so a fallback chain stops instead of trying its next model. See [Fallback](https://github.com/cloudflare/agents/blob/main/docs/agents/models-pi-ai.md#fallback).
