---
"@cloudflare/think": patch
---

Move experimental browser tools to codemode-backed `browser_execute` and re-export browser session manager helpers.

Use `cdp.spec()` inside `browser_execute` instead of the previous `browser_search` tool.
