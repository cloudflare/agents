---
"@cloudflare/think": patch
---

Avoid starting empty submission and workflow notification drains during agent startup, preventing short-lived facet initializations from leaving background keep-alive work behind.
