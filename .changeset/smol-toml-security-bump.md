---
"@cloudflare/worker-bundler": patch
---

Raise the `smol-toml` floor to ^1.7.2, picking up the fix for a
high-severity denial of service via malformed TOML (patched upstream
in 1.7.1).
