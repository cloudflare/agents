---
"agents": patch
---

`agents/models/pi-ai` parses streamed chat-completions tool-call arguments incrementally, instead of re-parsing the whole argument text on every delta.
