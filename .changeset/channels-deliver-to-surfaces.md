---
"agents": patch
---

Experimental Channels: `deliverToSurfaces(channel, { tasks })` serves a gateway Channel inside the agent, so each response of a conversation reaches every surface of that Channel that joined it, retried with backoff and never posted twice.
