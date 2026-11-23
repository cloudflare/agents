---
"agents": patch
---

Fix the chat recovery budget growing by a conversation's whole history on each new isolate, which sealed long conversations with `work_budget_exceeded` (#2702).
