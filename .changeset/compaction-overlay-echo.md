---
"agents": patch
"@cloudflare/think": patch
---

Stop storing compaction summaries echoed back by clients (#1984). A compaction overlay (a `compaction_<id>` message) is computed on read, but a client that posted its transcript back after a compaction had it filed as a real message row, so the summary appeared twice in every later read and compounded with each compaction. Session writes (`appendMessage`, `upsertMessage`, `updateMessage`) now drop overlay messages silently, and history reads, `getBranches`, `getLatestLeaf` and `search` skip overlay rows already stored by affected sessions, showing the rows parented to them in their place. Stored rows are left untouched.
