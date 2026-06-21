---
"agents": patch
---

Add the `action:ledger:reclaimed` diagnostics event to `AgentObservabilityEvent`, emitted when a stale `pending` action ledger row is reclaimed and re-run under the Think pending-retry lease.
