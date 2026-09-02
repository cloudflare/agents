---
"agents": patch
---

Keep attachments out of the message row.

A part that declares a non-text media type and carries its bytes inline is now stored separately, addressed by its SHA-256, and put back verbatim on read. The message keeps a pointer and its `mediaType`, so a round trip is exact and a message row stays small however large its payloads are. Read with `{ attachments: "pointer" }` to see the references instead.

The rule is typed rather than sized: an image is extracted at any size, and text is never extracted at any size — long prose still splits across continuation rows. The two mechanisms are independent, so media leaves before the row is measured and a message carrying a large image usually has no continuation rows at all.

Payload lifetime is derived from message references; the bytes go when the last reference does. Identical payloads store once, which makes a retried write free.
