---
"agents": patch
---

`agents tui` drops a `#fragment` from the URL it is given, since a WebSocket URL cannot carry one. Previously such a URL made the client exit before connecting.
