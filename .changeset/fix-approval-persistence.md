---
"@cloudflare/ai-chat": patch
---

Fix tool approval UI not surviving page refresh, and fix invalid prompt error after approval

- Handle `tool-approval-request` and `tool-output-denied` stream chunks in the server-side message builder. Previously these were only handled client-side, so the server never transitioned tool parts to `approval-requested` or `output-denied` state.
- Persist the streaming message to SQLite (without broadcasting) when a tool enters `approval-requested` state. The stream is paused waiting for user approval, so this is a natural persistence point. Without this, refreshing the page would reload from SQLite where the tool was still in `input-available` state, showing "Running..." instead of the Approve/Reject UI.
- On stream completion, update the early-persisted message in place rather than appending a duplicate.
- Fix `_applyToolApproval` to merge with existing approval data instead of replacing it. Previously `approval: { approved }` would overwrite the entire object, losing the `id` field that `convertToModelMessages` needs to produce a valid `tool-approval-request` content part. This caused an `InvalidPromptError` on the continuation stream after approval.
