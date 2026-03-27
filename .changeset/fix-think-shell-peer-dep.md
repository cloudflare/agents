---
"@cloudflare/think": patch
---

Fix `@cloudflare/shell` peer dependency to require `>=0.2.0`. Previously, npm could resolve an incompatible shell version, causing runtime errors. If you hit `Workspace` constructor errors, upgrade `@cloudflare/shell` to 0.2.0 or later.
