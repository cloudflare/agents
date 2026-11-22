---
"agents": patch
---

A callable whose result or stream chunk is larger than the 32 MiB WebSocket message limit now answers the client with an error and ends the stream, instead of leaving the call waiting; the runtime drops such messages without telling either side. This covers sub-agent callables too.
