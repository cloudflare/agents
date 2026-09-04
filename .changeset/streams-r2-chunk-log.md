---
"agents": minor
---

feat(streams): store chunk logs in R2 with `new Streams({ r2: env.BUCKET })`.

Stream rows (state, tag index, metadata, cursor) stay in DO SQLite; chunks go to R2 as a write-ahead log of segment objects, checkpointed every 25 chunks or 1 s (`r2Checkpoint`), so a Durable Object that dies mid-stream leaves everything up to its last checkpoint in R2 and a restarted producer resumes from it. Settlement compacts the segments into one exact-size object; `Streams.flush()` awaits it. The synchronous storage aperture used by chat stays SQLite-only.
