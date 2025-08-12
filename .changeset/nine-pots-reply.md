---
"agents": patch
---

log less data

as part of our observability impl, we were logging way too much data, making it a probable data leak, but also blowing past the max size limit on o11y messages. This reduces the amount of data logged.
