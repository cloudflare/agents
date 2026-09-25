---
"agents": patch
---

Sessions: keep the attachment references a rewritten message still points at.

A message whose media had already been offloaded carries `attachment:sha256:…`
pointers rather than inline bytes. Extraction derived the reference set from
what that one write pass extracted, so writing such a message back — an
`updateMessage` of a stored form, or the `importMessage` verbatim path that
exists for exactly this shape — recorded no reference, dropped the ones the
message held, and collected the payload while the row still pointed at it. The
message became permanently unresolvable.

References now follow what the stored row says: hashes extracted on this pass
plus every pointer the message already carried, at any nesting depth. A record
carrying a pointer is still walked for media in its sibling fields, and a read
resolves those siblings too, so nested media is offloaded and restored
symmetrically.

Rows already orphaned by the old behaviour are not repaired — those bytes are
gone — but no new write can orphan one.
