---
"agents": patch
---

Streams: a live `read`/`readBatches` no longer misses chunks appended while the consumer is still handling the previous batch. It re-polls before waiting for the next append, so a reader no longer stalls until a later append or the stream's end.
