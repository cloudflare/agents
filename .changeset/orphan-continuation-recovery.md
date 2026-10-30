---
"@cloudflare/think": patch
"agents": patch
---

Fix Think persisting a recovered interrupted continuation as a new assistant message each time it was recovered. A continuation stream now records the id of the message it continues and how many parts that message already held, so orphan recovery updates that one message instead of appending a copy with a duplicate tool call.
