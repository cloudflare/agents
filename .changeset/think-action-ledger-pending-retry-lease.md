---
"@cloudflare/think": minor
---

Add a pending-retry lease for the action ledger via the new `actionLedgerPendingRetryLeaseMs` config (default 5 minutes). A `pending` ledger row left behind by a crashed executor is now reclaimed and re-run once it is stale, but ONLY for actions that declare an explicit `idempotencyKey` — the key is the developer's assertion that re-running the keyed side effect is safe. Behavior change: such a stale row previously blocked forever with `ActionPendingError`; it now reclaims (refreshing `updated_at` in place, still `pending`), emits `action:ledger:reclaimed`, and re-runs `execute`. Fresh rows, fallback `tool:${toolCallId}` keys, and a disabled lease (`actionLedgerPendingRetryLeaseMs = false`) keep the conservative `ActionPendingError` behavior. Same-isolate coalescing still wins first, so an in-flight run is never reclaimed.
