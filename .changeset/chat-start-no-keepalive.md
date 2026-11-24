---
"agents": patch
---

A chat agent that starts with no stored requests to replay no longer arms and drops a keep-alive job, and checks for the requests table without scanning the schema.
