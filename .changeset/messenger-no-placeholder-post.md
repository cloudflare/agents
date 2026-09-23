---
"@cloudflare/think": patch
---

Messenger replies no longer post a `...` placeholder before the answer on adapters without native streaming. The first post now carries the start of the reply and is edited as the rest streams in, so notification previews (for example, in Slack) show real content. Replies delivered by recovery after a restart get the same behaviour.
