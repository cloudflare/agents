---
"agents": patch
---

Sessions keeps a reasoning part's OpenAI item id when the same message holds a provider-executed tool call such as `web_search`, so the next request no longer fails with "web_search_call was provided without its required reasoning item" (#2639).
