---
"@cloudflare/ai-chat": patch
---

Fix duplicate assistant messages when using needsApproval tools

When calling `addToolApprovalResponse`, the original assistant message is now updated in place instead of creating a duplicate with a new ID.
