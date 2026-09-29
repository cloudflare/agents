---
"agents": patch
---

`CdpConnection.send()` now rejects straight away when the socket is already closed, instead of leaving the command pending until it times out.
