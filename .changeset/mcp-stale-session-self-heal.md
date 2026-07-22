---
"agents": patch
---

Recover streamable HTTP connections when a server rejects a persisted session with HTTP 404. The client clears the stale session from memory and storage, initializes a new session, and rediscovers capabilities once.
