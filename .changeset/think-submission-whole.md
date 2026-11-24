---
"@cloudflare/think": patch
---

`submitMessages` stores each submitted message whole, as chat messages are; it no longer cuts tool outputs and text from a message over 1.8 MB. A submission whose messages total more than 16 MiB is now refused: `submitMessages` throws a `TaskSerializationError` instead of accepting it with its large parts cut.
