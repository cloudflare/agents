---
"agents": patch
---

Sessions: keep the attachment references of a message written back with pointers in it.

A message whose media was already offloaded carries `attachment:sha256:…` pointers. Writing that stored form back (an `updateMessage`, or a copy through `appendMessage` or `importMessage`) derived references only from media extracted on that write, so it recorded none, and the payload could be collected while the row still pointed at it. References now cover every pointer the stored message contains. Rows already orphaned are not repaired.
