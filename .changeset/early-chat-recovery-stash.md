---
"@cloudflare/think": patch
"agents": patch
"@cloudflare/ai-chat": patch
---

Stash chat turn recovery metadata before inference starts so interrupted pre-stream turns can be reconciled by chat recovery. Pre-stream interruptions now automatically retry the existing unanswered user message when it is still safe to do so.
