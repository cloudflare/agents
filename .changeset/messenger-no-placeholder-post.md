---
"@cloudflare/think": patch
---

Messenger replies no longer post a `...` placeholder before the answer on adapters without native streaming. The first post now carries the start of the reply and is edited as the rest streams in, so notification previews (for example, in Slack) show real content. Replies delivered by recovery after a restart get the same behaviour, and are bound to their own messenger's adapter even when another agent in the same isolate registers its Chat while recovery is in flight. A turn that produces no text streams the empty-response text as its reply rather than a blank message, and `TextStreamCallback` gains an `emptyText` option and a `complete()` method for custom delivery code that wants the same.
