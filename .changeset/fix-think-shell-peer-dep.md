---
"@cloudflare/think": patch
---

Fix `@cloudflare/shell` peer dependency to require `>=0.2.0`. Installing Think with shell 0.1.x would fail at runtime due to a Workspace constructor change. If you're on shell 0.1.x, upgrade to 0.2.0 or later.
