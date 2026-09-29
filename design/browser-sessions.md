# Browser Sessions

**Status:** internal (`browser/browser.ts` — not exported)

## Problem

Harness evaluations of the codemode browser surface ([browser-tools.md](./browser-tools.md)) showed the model spending most of its budget managing browser lifetime rather than doing its task: rediscovering and reattaching to tabs with `Target.getTargets` / `attachToTarget` in the majority of executions, deciding when to promote or close sessions, and failing when raw CDP session ids went stale across executions. Browser lifetime should be a host concern: each execution should run against one consistent browser, and the model should only hear about lifetime when its browser was replaced.

## How it works

A `Browser` is one named browser that outlives agent runs. It is internal for now: `browser_execute`, quick actions, and the connector keep shipping unchanged. Raw CDP stays the model's interaction surface — `Browser` changes who owns the browser, not how the model drives it.

```ts
new Browser({ provider: browserRun(env.BROWSER), name: "research" });
```

- **One object, one browser.** The host picks the name (default `"default"`); the model never sees it or the Browser Run session id. Two browsers on one Durable Object means two `Browser` objects with different names.
- **Provider.** `browserRun(binding, options)` says where the browser runs. Its options (`keepAliveMs`, `recording`, `guardrails`) are applied every time a browser is created, including replacements. `keep_alive` defaults to the 600-second platform maximum. Browser Run is the only provider today; bring-your-own-browser would be another provider.
- **`resolve()` / `connect()`.** Reattach to the browser if it is alive, otherwise create one. `restarted: true` means an earlier browser for this name was lost (closed, idle past `keep_alive`, or crashed) and its tabs and logins are gone. Only the first-ever use reports `false`. `connect()` also opens a `CdpConnection`; closing it leaves the browser running. If the browser expires between the liveness probe and the connection (404/410 on the WebSocket upgrade), `connect()` replaces it and returns the new one with `restarted: true`.
- **`close()`.** Retires the record and deletes the Browser Run session best-effort; if the delete fails, `keep_alive` reclaims it.
- **`liveView({ mode })`.** Fresh Live View URLs for the browser's tabs (valid ~5 minutes to connect, never stored), or `undefined` when there is no live browser. Minting counts as activity, and a link that loses a race with `close()` reports the browser gone instead of returning dead URLs. The helpers live in `browser/live-view.ts`, shared with the connector.
- **Lifecycle capability.** Installed with `Lifecycle.use()` (id `browser:<name>`), a `Browser` stores its record in the Durable Object's storage. Pass a custom `store` to use it without Lifecycle. It schedules nothing: no jobs, alarms, or hooks.

### Storage and concurrency

- The record lives at `browser:session:<name>`, separate from the connector's `cdp:exec:` / `cdp:reuse:` entries.
- There is no host-side sweep. Browser Run reclaims an idle browser; the next `resolve()` finds it dead (404/410 on the liveness probe) and replaces it.
- `close()`, and a `resolve()` that finds the browser dead, move the record to a permanent `browser:retired:<name>` marker. The marker is what makes the next `resolve()` report `restarted: true`. It is read under the commit lock, so a browser created and closed while another create is in flight still counts.
- CDP commands on `connect()` connections, reattaches, and Live View links refresh the record's `updatedAt`, at most once per 60 seconds (capped at half `keep_alive`). A refresh never brings back a record that was closed or replaced.
- Store locks cover storage reads and writes only — never Browser Run network calls. Concurrent resolvers commit first-wins, and the loser deletes its extra browser.

`openOneShotBrowserSession` (in `browser-run.ts`) covers store-less create-and-close use, including Kitesurf, which is connection-scoped and so one-shot only. Choosing `browser: "kitesurf"` removes the Chromium-only options (`guardrails`, `keepAliveMs`, `recording`) at the type level, backed by a runtime guard for plain-JS callers.

A Durable Object that drives its browser directly:

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

export class ResearchObject extends DurableObject<Env> {
  readonly browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      guardrails: { allowedDomains: ["docs.example.com"] }
    })
  });
  readonly lifecycle = Lifecycle.install(this).use(this.browser);

  async onRequest(_request: Request): Promise<Response> {
    // First call launches the browser; later calls reattach to it.
    const { cdp, restarted } = await this.browser.connect();
    if (restarted) {
      // Fresh browser — earlier pages are gone; navigate again before use.
    }
    try {
      await cdp.send("Page.navigate", { url: "https://docs.example.com" });
    } finally {
      cdp.close(); // closes the connection; the browser stays alive
    }
    return new Response("done");
  }
}
```

On an `Agent` subclass, install with `this.lifecycle.use(this.browser)` in the constructor instead of `Lifecycle.install(this)`.

## Key decisions

- **Raw CDP remains the model interaction surface.** A typed verb API was prototyped and parked until evaluations can show it beats raw CDP (see the `park/browser-interaction-contract` branch).
- **The host names the browser, not the model.** The connector's `dynamic` mode let the model promote a session; here the host picks a name and `Browser` owns attachment. Recreation is loud (`restarted`), never silent.
- **One `Browser` per browser.** An earlier version was a single `BrowserSessions` capability taking a name on every call, over a separate internal engine. Hosts couldn't tell the two apart, and naming the browser once at construction is simpler.
- **Browser Run owns idle reclamation.** An earlier version swept idle sessions from a Lifecycle job. It duplicated `keep_alive`, woke idle objects, needed its own crash-recovery and race handling, and could delete a browser a human was driving through Live View, since that traffic bypasses the host. Dead-browser detection in `resolve` already covers correctness.
- **The connector is untouched.** Its `reuse`/`dynamic` modes overlap `Browser` for now; the overlap is bounded and resolves when the model surface moves onto `Browser`.

## Tradeoffs

- Temporary duplication between connector session modes and `Browser`.
- Without a sweep, the record of an expired browser stays in storage until the browser is next resolved or closed.
- A host that wants idle browsers reclaimed sooner than 10 minutes lowers `keepAliveMs` rather than relying on a sweep.
- Retired markers (`browser:retired:<name>`) are never deleted, so storage grows with the number of distinct names a host has ever used. Names are host-chosen and few in practice; per-user or per-task names would need an explicit forget operation.

## Relationship to browser-tools.md

[browser-tools.md](./browser-tools.md) describes the shipping codemode connector surface (`browser_execute`, quick actions, Live View, recording). This document describes the internal `Browser` being built beneath it. The two share `browser-run.ts`, the session stores, and `live-view.ts`.
