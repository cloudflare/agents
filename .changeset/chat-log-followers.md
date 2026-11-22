---
"agents": patch
---

Internal: chat hosts no longer scan every connection per streamed chunk, and a reply that ends without a terminal frame no longer leaves its stored batch open. No API change.
