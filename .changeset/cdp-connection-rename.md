---
"agents": patch
---

`CdpSession` is renamed to `CdpConnection`, since it is one WebSocket connection to a browser and CDP already uses "session" for a tab. `CdpSession` still works as a deprecated alias.
