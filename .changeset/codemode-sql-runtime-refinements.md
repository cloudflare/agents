---
"@cloudflare/codemode": minor
---

Codemode runtime refinements (pre-release):

- **SQL storage.** The `CodemodeRuntime` facet now stores executions, the tool-call log, and snippets in SQLite tables (one row per log entry) instead of single key-value blobs — appends no longer rewrite the whole execution, and pruning/expiry/listing are indexed. Args/results are serialized with a binary- and bigint-safe codec.
- **Size guards.** Any single recorded value (call args, a recorded result, the final result) is capped at 1 MB serialized (`MAX_DURABLE_VALUE_BYTES`). Oversized args or call results fail the run with a model-actionable error; an oversized final result completes normally with a placeholder in the audit trail.
- **Replay policy.** Connector tools can declare `replay: "reexecute"`: the call is logged for sequencing/divergence but its result is never stored — replays re-execute it. For idempotent reads with large results. Incompatible with `requiresApproval`.
- **`onPassEnd` hook.** Connectors get `onPassEnd(executionId, status)` at the end of every execution pass — including pauses, where `disposeExecution` deliberately does not fire — to release per-pass resources (sockets, leases).
- **Explicit runtime identity.** The runtime facet is keyed by an explicit `name` (default `"default"`) instead of a fingerprint of the connector set, so executions and snippets survive connector changes. Each execution/snippet records the connector names it needs; resume and `codemode.run` verify them and fail with a clear error when one is missing.
- **`expirePaused`.** `runtime.expirePaused({ maxAgeMs })` (default 24h) marks stale awaiting-approval runs rejected and fires `disposeExecution`, reclaiming their resources — for use from a recurring alarm/scheduled task.
- **Reserved-name hardening.** The executor rejects provider/connector names that would shadow harness globals (`Promise`, `setTimeout`, `Error`, `console`, …).
