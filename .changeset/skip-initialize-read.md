---
"agents": patch
---

Streamable HTTP `initialize` requests no longer read the session's stored initialize request first, removing one Durable Object round trip when a session starts.
