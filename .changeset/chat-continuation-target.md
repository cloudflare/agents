---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Auto-continuation runs only for a tool result that settled its call, and only while the conversation has not moved past that call's message (a newer question, or a reply a later turn stored), in both `AIChatAgent` and `Think`. A message appended without a turn, such as a narrated background-run milestone or a status message stored with `persistMessages`, does not count: the tool result is still answered, in `AIChatAgent` as a new reply after the appended message.
