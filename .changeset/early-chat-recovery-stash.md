---
"@cloudflare/think": patch
"agents": patch
"@cloudflare/ai-chat": patch
---

Stash chat turn recovery metadata before inference starts so interrupted pre-stream turns can be reconciled by chat recovery. Add `retry: true` as a chat recovery option for retrying an interrupted turn against the existing unanswered user message.
