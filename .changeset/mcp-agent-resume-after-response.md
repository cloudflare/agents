---
"agents": patch
---

`McpAgent` keeps a finished tool call's events for five minutes, so a client that reconnects with `Last-Event-ID` after the tool returned still gets the result, and a resumed stream now ends once it has delivered it.
