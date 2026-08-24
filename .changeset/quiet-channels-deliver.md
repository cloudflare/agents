---
"@cloudflare/channels": minor
---

Add the experimental `@cloudflare/channels` package: one transport-neutral way to receive and send messages over Slack, Telegram, email, and channels of your own.

A stateless `ChannelHost` authenticates and normalizes provider input, and your application decides where each event belongs and how to store it. Outbound delivery reports honest per-attempt outcomes, approvals can be rendered natively by each provider, and channel identities can be linked to your own users.
