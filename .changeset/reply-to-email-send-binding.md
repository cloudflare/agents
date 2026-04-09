---
"agents": patch
---

Allow `replyToEmail()` to send through Cloudflare Email Service `send_email` bindings. The method now uses `this.env.EMAIL` automatically when present, and also accepts an explicit `sendBinding` option for differently named bindings.
