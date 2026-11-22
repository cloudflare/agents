---
"@cloudflare/think": patch
---

Think's skills, extension hooks and extension host operations live in their own modules. `HostBridgeLoopback` reaches the agent through one `_cfHostBridge` entry point instead of nine `_host*` methods.
