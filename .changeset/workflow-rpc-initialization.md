---
"agents": patch
---

Fix workflow RPC callbacks bypassing Agent initialization. The `_workflow_handleCallback`, `_workflow_broadcast`, and `_workflow_updateState` methods now call `__unsafe_ensureInitialized()` before executing, ensuring `this.name` is hydrated and `onStart()` has been called even when the Durable Object wakes via native RPC.
