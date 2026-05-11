---
"agents": patch
---

Fixed a bug that could cause client state to drift from internal Durable Object state when agent tool calls spanned a Durable Object restart. Recovery now defers user finish hooks until after agent startup and isolates hook failures so one failed mirror write does not block other recovered runs from finalizing.
