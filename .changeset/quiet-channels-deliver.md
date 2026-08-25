---
"agents": minor
"@cloudflare/voice": minor
---

Add experimental stateless messaging Channels under `agents/channels`. A `ChannelRouter` authenticates and normalizes provider input, and the application decides where each event belongs and how to store it. Outbound delivery reports honest per-attempt outcomes, approvals can be rendered natively by each provider, and Channel identities can be linked to application users.

Add the browser voice Channel adapter under `@cloudflare/voice/channels`.
