---
"agents": patch
---

`connectBrowserSession` now throws a `BrowserRenderingError` carrying the HTTP status when Browser Run returns no WebSocket, instead of a plain `Error`. The message now ends with the status, for example `(410)` when the session has expired.
