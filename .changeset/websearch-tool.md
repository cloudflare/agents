---
"agents": minor
---

Add `agents/websearch`: a `websearch` tool over Cloudflare's Web Search API (AI Gateway), with adapters for the pi harness (`agents/websearch/pi`), the AI SDK (`agents/websearch/ai-sdk`), and TanStack AI (`agents/websearch/tanstack-ai`). The host picks the gateway, provider (`ceramic`, `exa`, or `linkup`), and billing; the model picks the query and result count. Results reach the model as trimmed text and the host as the full API response. `agents/websearch` also exports `webSearchFromAI` and `webSearchFromRest` for searching without a model in the loop.
