---
"agents": patch
---

Fix `routeAgentEmail()` keeping the target DO non-hibernatable for ~100-120s after `onEmail()` returns. Replaces bare closure RPC targets with a single `RpcTarget` bridge (`EmailBridge`) that has explicit `Symbol.dispose` lifecycle, allowing the runtime to tear down the bidirectional RPC session promptly instead of tying it to the caller's execution context lifetime.
