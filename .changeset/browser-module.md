---
"agents": minor
---

`browserTool`'s model code now calls a `browser` global (`browser.cdp(...)`, `browser.spec({ domain })`) instead of `cdp.send(...)`, and the result's `notice` replaces the `restarted` and `newTabs` fields. See [Persistent browser](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md#persistent-browser).
