---
"agents": patch
---

Message reconciliation now protects **all** resolved terminal tool states from being clobbered by a stale client message — not just `output-available`.

`reconcileMessages` (used at persistence time by both Think and AIChatAgent) merges the server's resolved tool result into an incoming client message that still shows a pre-output state (`input-available` / `approval-requested` / `approval-responded`). Previously it only carried over `output-available`, so if the server had already resolved a tool to `output-error` or `output-denied` and the client persisted a stale `input-available` (e.g. a reconnect/optimistic race before it saw the resolution), the stale state overwrote the server's terminal result — losing the error or the user's denial.

The merge now indexes `output-available`, `output-error`, and `output-denied` server parts and overlays the appropriate result field (`output` / `errorText` / `approval`) onto the stale client part.
