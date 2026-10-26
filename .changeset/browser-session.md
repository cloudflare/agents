---
"agents": minor
---

`browserTool` now runs the model's code in its own Dynamic Worker instead of on codemode, so it needs no `ctx` or `CodemodeRuntime` export (keep `@cloudflare/codemode` installed for now) and its output has no `calls` log; `browser.session()` gives your own code the same connection to the browser. See [Persistent browser](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md#persistent-browser).
