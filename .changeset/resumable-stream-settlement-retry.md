---
"agents": patch
---

Expose `ResumableStream.pendingCutoverId` so callers can detect whether a finished stream still awaits its cutover, and clear the pending-cutover marker only after settlement succeeds in `finalizePending`, keeping a failed settlement retryable instead of silently leaving the stream row live.
