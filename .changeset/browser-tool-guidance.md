---
"agents": patch
---

`browserTool` now puts its CDP rules and run time limit in the tool description, so the model can start without a `codemode.search` pass, and explains how to take a smaller screenshot when one is over the 1 MB result limit. See [Persistent browser](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md#persistent-browser).
