---
"agents": patch
---

Fix MCPClientManager OAuth callback tests to match current `handleCallbackRequest` behavior. The method now returns `{ authSuccess: false, authError }` result objects instead of throwing, so update three tests that used `.rejects.toThrow()` to assert on the resolved result instead.
