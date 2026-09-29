---
"agents": patch
"@cloudflare/think": patch
---

Stop storing compaction summaries echoed back by clients (#1984). A compaction overlay (a `compaction_<id>` message) is computed on read, but a client that posted its transcript back after a compaction had it filed as a real message row, so the summary appeared twice in every later read and compounded with each compaction. Session writes (`appendMessage`, `upsertMessage`, `updateMessage`) now drop overlay messages silently. For sessions already affected, history reads, `getBranches`, `getLatestLeaf` and `search` skip a stored `compaction_<id>` row that duplicates one of the session's own compaction records, showing the rows parented to it in its place. Stored rows are left untouched, and a summary imported from another session's history with `importMessage` stays visible.
