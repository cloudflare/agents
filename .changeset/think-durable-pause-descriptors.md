---
"@cloudflare/think": minor
---

Add durable-pause approval descriptors: `durable-pause` actions now park in a dedicated `cf_think_action_pending_approvals` store and resume via `approveExecution`/`rejectExecution` with a connection-independent continuation, so a turn can be approved from a dashboard with no live socket (this also fixes codemode `approveExecution` from a dashboard). A unified `ActionApprovalDescriptor` is attached to durable-pause, codemode, and approval-gated parts, `pendingApprovals()` lists all pending approvals for cold-load reconciliation, and an overridable `describePausedExecution()` hook enriches codemode descriptors.
