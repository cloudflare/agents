---
"agents": minor
---

`browserTool` no longer runs on codemode, so it needs no `ctx` or `CodemodeRuntime` export and its output has no `calls` log; `browser.session()` is new and `BrowserConnector` is deprecated. See [Persistent browser](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md#persistent-browser).
