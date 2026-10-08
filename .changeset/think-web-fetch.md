---
"@cloudflare/think": patch
---

`fetch_url` now blocks private and local hosts with the shared policy from `agents/webfetch` instead of its own list, and the `agents` peer dependency floor rises to `>=0.28.0`. See [Fetch the Web: URL policy](https://github.com/cloudflare/agents/blob/main/docs/agents/fetch-the-web.md#url-policy).
