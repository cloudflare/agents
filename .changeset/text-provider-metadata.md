---
"agents": patch
---

Stored text and reasoning parts keep the `providerMetadata` of their start chunk (and text parts that of their deltas and end), as the AI SDK does; before, only reasoning deltas and ends were kept.
