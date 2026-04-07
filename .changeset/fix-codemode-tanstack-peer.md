---
"@cloudflare/codemode": patch
---

Fix `@tanstack/ai` peer dependency range from `^0.8.0` to `>=0.8.0 <1.0.0`. The caret range for pre-1.0 packages only allows `>=0.8.0 <0.9.0`, which excluded the current 0.10.0 release.
