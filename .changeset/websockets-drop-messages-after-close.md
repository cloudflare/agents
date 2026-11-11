---
"agents": patch
---

Stop running client messages on a WebSocket the host has closed. A connection rejected from `onConnect` with `connection.close()` could still run one `@callable` method, state update, or `onMessage` call. The close happens before the client has the upgrade response, so anything the client sent as soon as it connected arrived after the close, and the platform still delivered it. `Connection.close()` now records the close in the socket attachment, so the record survives hibernation, and the `WebSockets` capability drops every later message on both the hibernating and Cap'n Web wires. Messages the client sent before closing the connection itself still run.
