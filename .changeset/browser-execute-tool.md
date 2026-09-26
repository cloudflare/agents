---
"agents": minor
---

Add `createBrowserExecuteTool` (`agents/browser/ai`), a `browser_execute` tool that drives one persistent, host-named browser, and export the `BrowserSessions` Lifecycle capability it runs on (`agents/browser`). Both are experimental.

The host installs one `BrowserSessions` and passes it in, so tools rebuilt every turn reach the same browser; tabs, cookies, and logins survive between executions until Browser Run's `keep_alive` reclaims an idle browser.

```ts
import { BrowserSessions } from "agents/browser";
import { createBrowserExecuteTool } from "agents/browser/ai";

export class MyAgent extends Agent<Env> {
  browser = new BrowserSessions({ browser: this.env.BROWSER });

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.browser);
  }

  getTools() {
    return createBrowserExecuteTool({
      sessions: this.browser,
      loader: this.env.LOADER
    });
  }
}
```

The model writes raw CDP as with `createBrowserTools`, with no session-management calls: `cdp.send({ method, params, sessionId: "active" })` targets the tab the agent is working in, which the host remembers across executions. Tabs the page opens are returned as `newTabs`, and if the browser had to be replaced the code still runs and the result reports `restarted: true`. Chromium on a Browser Run binding only; `createBrowserTools` keeps `cdpUrl`, Kitesurf, and its session modes unchanged. Hosts hand humans a Live View link with `browser.liveView(name)`.
