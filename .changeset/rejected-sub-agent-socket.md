---
"agents": patch
---

Stop clients from retrying a sub-agent WebSocket forever after `onBeforeSubAgent` rejects it (#2118).

A `Response` returned from `onBeforeSubAgent` for a WebSocket upgrade used to fail the handshake. Browsers hide the status of a failed handshake, so `useAgent` and `AgentClient` treated it as a network error and reconnected indefinitely. The upgrade is now accepted and immediately closed: a `4xx` status closes with code `4000 + status` (for example `4404`), which clients treat as terminal, and any other status closes with `1011`, which is retried. The close reason is `Sub-agent connection rejected (<status>)`. Rejections at deeper hops use the same codes instead of `1008`.

`connectionError` and `onConnectionError` now report every close that ends reconnection, not only terminal close codes: `shouldReconnectOnClose` returning false and running out of `maxRetries` also set them, and pending calls are rejected. An explicit `close()` still does not.
