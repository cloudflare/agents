---
"agents": patch
---

`agents tui` now handles Cloudflare Access: for a URL behind Access, it gets a token from `cloudflared` (logging in through the browser the first time) and sends it on the WebSocket upgrade. `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` and explicit `--header` credentials still take precedence.
