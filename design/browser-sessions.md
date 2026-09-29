# Persistent Browser

**Status:** experimental (`Browser` exported from `agents/browser`)

## Problem

When we tested the original browser tool ([browser-tools.md](./browser-tools.md)) with real models, they spent most of their effort keeping track of the browser instead of doing the task. They looked up and reattached to tabs at the start of most runs, decided when to keep or close browsers, and broke when a tab handle from an earlier run stopped working.

Keeping the browser alive is the host's job. Every run should land in the same browser, and the model should only hear about it when that browser was lost and replaced.

## How it works

A `Browser` is one browser that outlives agent runs. It powers `browserTool`, which lets the model drive the browser by writing CDP code ([browser-tools.md](./browser-tools.md#persistent-browser-tool)). The host can also use it directly.

```ts
import { Browser, browserRun } from "agents/browser";

const browser = new Browser({
  provider: browserRun(env.BROWSER, { recording: true }),
  name: "research" // optional, defaults to "default"
});
```

- **One object, one browser.** The name tells browsers apart when a Durable Object has more than one. The model never sees the name.
- **Provider.** `browserRun(binding, options)` runs the browser on Browser Run. Its options (`keepAliveMs`, `recording`, `guardrails`) apply every time a browser is created, including replacements. `keepAliveMs` defaults to the platform maximum of 10 minutes. Browser Run is the only provider today; bring-your-own-browser would be another one.
- **`connect()`** reattaches to the browser if it's still running and starts a new one if not. It returns a `CdpConnection`; closing that connection leaves the browser running. `resolve()` does the same without opening a connection.
- **`restarted: true`** means an earlier browser was lost (closed, idle too long, or crashed), and its tabs and logins are gone. The very first browser reports `false`.
- **`close()`** shuts the browser down.
- **`liveView()`** returns fresh Live View links to the browser's tabs, so a person can watch or take over. It returns `undefined` when there's no running browser.
- **Lifecycle.** Install a `Browser` with `Lifecycle.use()` and it keeps its record in the Durable Object's storage. It never schedules alarms or jobs. Pass your own `store` to use it without Lifecycle.

A Durable Object using its browser directly:

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Browser, browserRun } from "agents/browser";

export class ResearchObject extends DurableObject<Env> {
  readonly browser = new Browser({ provider: browserRun(this.env.BROWSER) });
  readonly lifecycle = Lifecycle.install(this).use(this.browser);

  async fetch(): Promise<Response> {
    const { cdp, restarted } = await this.browser.connect();
    if (restarted) {
      // A new browser: earlier pages are gone.
    }
    try {
      await cdp.send("Page.navigate", { url: "https://example.com" });
    } finally {
      cdp.close(); // the browser keeps running
    }
    return new Response("done");
  }
}
```

On an `Agent`, call `this.lifecycle.use(this.browser)` in the constructor instead.

### Details

- The browser's record is stored at `browser:session:<name>`: the Browser Run session id, timestamps, and the tab the agent last used.
- There's no cleanup job. Browser Run shuts down an idle browser on its own, and the next `connect()` notices and starts a new one.
- When a browser is lost or closed, a `browser:retired:<name>` marker is left behind. That marker is how the next `connect()` knows to report `restarted: true`. Markers are never deleted.
- CDP commands and Live View links count as activity and refresh the record at most once a minute. A refresh never brings back a browser that was closed or replaced.
- If two callers start a browser at the same time, the first one wins and the other closes its extra browser. Storage locks never wait on Browser Run network calls.
- If the browser dies between the liveness check and the WebSocket connection, `connect()` starts a new one and reports `restarted: true` instead of failing.

## Key decisions

- **The model still writes raw CDP.** A typed set of browser actions was prototyped and parked until tests show it beats raw CDP (see the `park/browser-interaction-contract` branch).
- **The host names the browser, not the model.** The original connector let the model decide when to keep a browser. Here the host decides, and a lost browser is always reported, never silently replaced.
- **One object per browser.** An earlier version had one object that managed every browser by name, on top of a separate internal class. The two were hard to tell apart, and naming the browser once up front is simpler.
- **Browser Run handles idle browsers.** An earlier version had a cleanup job. It duplicated `keepAliveMs`, woke idle objects, and could shut down a browser a person was using through Live View, because that traffic never reaches the host.
- **No provider interface yet.** `browserRun()` returns a plain config object. A real interface waits until there's a second provider to shape it.

## Tradeoffs

- `createBrowserTools` still has its own ways of keeping a browser across runs (the connector's `reuse` and `dynamic` modes). They overlap `Browser` until that tool moves onto it.
- Without a cleanup job, the record of a browser that timed out stays in storage until the next `connect()` or `close()`.
- To shut idle browsers down sooner than 10 minutes, lower `keepAliveMs`.
- Retired markers pile up, one per name ever used. That's fine for a few fixed names; per-user or per-task names would need a way to forget them.
