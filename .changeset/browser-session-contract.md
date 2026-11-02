---
"agents": minor
---

Add `Browser.functionDocs()`, `BrowserSession.functions`, report `notices`, opt-in scope locks (`browser.session({ lock: true })`, `session.lock()`) and `conversationScope()` to `agents/browser`, so code outside `browserTool` can run the same `browser` object. See [Browse the Web](https://developers.cloudflare.com/agents/tools/browser/).
