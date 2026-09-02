---
"agents": patch
---

Keep attachments out of the message row.

A part that declares a non-text media type and carries its bytes inline is now stored separately, addressed by its SHA-256, and put back verbatim on read. The message keeps a pointer and its `mediaType`, so a round trip is exact and a message row stays small however large its payloads are. Read with `{ attachments: "pointer" }` to see the references instead.

The rule is typed rather than sized: an image is extracted at any size, and text is never extracted at any size — long prose still splits across continuation rows. The two mechanisms are independent, so media leaves before the row is measured and a message carrying a large image usually has no continuation rows at all.

Payload lifetime is derived from message references; the bytes go when the last reference does. Identical payloads store once, which makes a retried write free.

`getRecentHistory()` loses its `minRecentMessages` argument. The byte budget is now a hard ceiling: a message-count floor admitted rows whatever their size, so a window of media-heavy messages could hydrate far past the limit meant to bound it. The newest message is always returned.

Also fixes two migration faults that could lose data: `AIChatAgent` dropped its legacy table when rows were merely *accounted for* rather than imported, deleting any row that failed to parse; and Sessions stamped its schema version even when a legacy lift was incomplete, so it never retried. Both lifts are idempotent, so the source now survives until every row has actually landed.
