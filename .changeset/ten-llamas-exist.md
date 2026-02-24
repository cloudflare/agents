---
"@cloudflare/ai-chat": patch
---

Fix denied tool approvals (`CF_AGENT_TOOL_APPROVAL` with `approved: false`) to transition tool parts to `output-denied` instead of `approval-responded`.

This ensures `convertToModelMessages` emits a `tool_result` for denied approvals, which is required by providers like Anthropic.

Also adds regression tests for denied approval behavior, including rejection from `approval-requested` state.
