---
"agents": patch
---

Add `sendEmail()` method to the Agent class for sending outbound email via Cloudflare Email Service. Pass your `send_email` binding explicitly as `this.sendEmail({ binding: this.env.EMAIL, ... })`. Automatically injects agent routing headers and supports optional HMAC signing for secure reply routing.
