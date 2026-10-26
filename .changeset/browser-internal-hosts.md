---
"agents": minor
---

Add `internalHosts` to `browserRun()` provider: set internal hostnames the browser can reach through your agent. Allow the model to point these hostnames at specific targets like container ports or workspace folders with `browser.assignHost()`. See [Internal hostnames](https://developers.cloudflare.com/agents/tools/browser/).
