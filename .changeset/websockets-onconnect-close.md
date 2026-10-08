---
"agents": patch
---

Deliver a close made from a WebSockets `onConnect` handler, or from `Agent.onConnect`, to the client. `onConnect` runs before the upgrade response is returned, and a hibernating socket closed at that point sent its Close frame but never ended the connection, so the client's `close` event never fired. The client now gets the frames sent before the close, then the close with its code and reason, and the host's `onClose` still runs.
