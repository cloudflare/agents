---
"@cloudflare/think": patch
---

`fetch_url` now blocks private and local hosts using the shared policy from `agents/webfetch`. See [Fetch the Web: URL policy](https://github.com/cloudflare/agents/blob/main/docs/agents/fetch-the-web.md#url-policy).
