---
"agents": patch
"@cloudflare/think": patch
---

Fix RPC resource leaks in workflows.

Workflows that use `waitForApproval()` or `ThinkWorkflow.prompt()` now release their RPC stubs promptly, preventing resource leaks and the associated "RPC stub was not disposed" warnings in your logs.
