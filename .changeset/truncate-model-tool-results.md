---
"agents": patch
"@cloudflare/think": patch
---

Keep older tool outputs valid for `toModelOutput` and provider-executed tools. Think now truncates older tool results after `convertToModelMessages` instead of rewriting the stored output, so a validating `toModelOutput` no longer throws once a large result ages past the recent-message window, and provider-executed results such as Anthropic web search are replayed intact. `truncateOlderMessages` skips provider-executed outputs, accepts `toolOutputs: false`, and the new `truncateOlderToolResults` helper truncates converted model messages (#2014).
