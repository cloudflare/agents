---
"@cloudflare/think": patch
---

Forward `TurnConfig.experimental_telemetry` to Think's internal AI SDK
`streamText()` call so applications can configure per-turn LLM observability.
