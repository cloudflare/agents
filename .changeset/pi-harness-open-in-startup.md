---
"agents": patch
---

Fix the experimental pi harness hanging on restart. An operation that arrived before Lifecycle startup opened pi itself, and startup then waited on that open behind a closed input gate, so the open's timers and I/O never ran and the object reset after 30 seconds. Every operation now waits for startup, which opens pi.
