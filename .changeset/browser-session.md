---
"agents": minor
---

`createBrowserTool` no longer runs on `@cloudflare/codemode`. It runs the model's code in a fresh Dynamic Worker from the `loader` you pass, with no network access, so it needs neither `ctx` (now ignored) nor a `CodemodeRuntime` export. Its output no longer has a `calls` log. The new `browser.session()` returns a `BrowserSession`, the per-run connection the tool's `cdp` object is built on, which `@cloudflare/computer`'s `ws:browser` module also uses. `BrowserConnector`, its option types and `DEFAULT_EXEC_SWEEP_IDLE_MS` are now marked deprecated.
