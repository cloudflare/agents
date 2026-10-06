---
"agents": patch
---

`browserTool` now has its own tool description instead of codemode's generic one. It covers the `cdp` API, common CDP mistakes, and the run time limit, so the model no longer runs `codemode.search` first. It also explains how to take a smaller screenshot when one is over the 1 MB result limit. See [Persistent browser](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md#persistent-browser).
