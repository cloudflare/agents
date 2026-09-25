# Browser Sessions

**Status:** experimental (`BrowserSessions` exported from `agents/browser`; `NamedBrowserSessions` in `session-core.ts` stays internal)

## Problem

Harness evaluations of the codemode browser surface ([browser-tools.md](./browser-tools.md)) showed the model spending most of its budget managing browser lifetime rather than doing its task: rediscovering and reattaching to tabs with `Target.getTargets` / `attachToTarget` in the majority of executions, deciding when to promote or close sessions, and failing when raw CDP session ids went stale across executions. Browser lifetime should be a host concern: each execution should run against one consistent browser, and the model should only hear about lifetime when its browser was replaced.

## How it works

Two layers, added additively. `BrowserSessions` is exported from `agents/browser` and drives `createBrowserExecuteTool` ([browser-tools.md](./browser-tools.md#persistent-browser-tool)); the core beneath it stays internal. `createBrowserTools`, quick actions, and `BrowserConnector` keep shipping unchanged. Raw CDP stays the model's interaction surface — these layers change who owns the browser, not how the model drives it.

### Named session core (`browser/session-core.ts`)

`NamedBrowserSessions` gives hosts named, reattach-or-create Browser Run sessions:

- Names are the identity; the model never sees platform session ids. Records live under a `browser:session:<name>` keyspace, distinct from the connector's `cdp:exec:` / `cdp:reuse:` entries.
- `resolve(name)` reattaches to a live session or creates a replacement, reporting `restarted: true` when the previous browser died, expired, or was closed — only first-ever use of a name reports `false`.
- Creation options (`keepAliveMs`, `recording`, `guardrails`) are durable: reapplied to every replacement session. `keep_alive` defaults to the 600-second platform maximum.
- There is no host-side sweep. Browser Run's `keep_alive` reclaims an idle browser; the next `resolve` finds it dead (404/410 on the liveness probe) and replaces it.
- `close`, and a `resolve` that finds its browser dead, retire the name under its lock: the record moves to a permanent `browser:retired:<name>` marker outside the named-session keyspace. The marker is what makes the next `resolve` report `restarted: true`, and it is read under the commit lock, so a name created and closed while another create is in flight still counts as used. `close` then deletes the Browser Run session best-effort; if that fails, `keep_alive` reclaims it.
- `connect(name)` attaches a CDP socket to the resolved browser. If the browser expires between the liveness probe and the WebSocket upgrade (404/410 on the upgrade), it retires the record and resolves once more, returning the replacement with `restarted: true`. The returned `setActiveTarget(targetId)` records the agent's current tab on the record (`activeTargetId`) only while the record still holds that browser; a replacement starts with no active tab.
- CDP commands on sockets from `connect`, reattaches, and Live View links refresh the record's `updatedAt`, throttled to once per 60 seconds (capped at half `keep_alive`). A refresh never recreates a record that was closed or replaced in the meantime.
- Store locks are held around storage reads and writes only — never across Browser Run network calls. Concurrent resolvers commit first-wins, and the loser deletes its redundant browser.
- `openOneShotBrowserSession` covers store-less create-and-close use, including Kitesurf (which is connection-scoped, so it is one-shot only). Engine options are discriminated unions: choosing `browser: "kitesurf"` removes the Chromium-only options (`guardrails`, `keepAliveMs`, `recording`) at the type level, backed by one runtime guard per entry point for plain-JS callers.

### `BrowserSessions` lifecycle capability (`browser/capability.ts`)

A `LifecycleCapability` (id `"browser"`) composable onto an `Agent` subclass or a plain Durable Object via `Lifecycle`:

- Auto-supplies a `DurableBrowserSessionStore` over the Durable Object's storage; hosts may pass their own store.
- Schedules nothing: no Lifecycle jobs, alarms, or hooks. An object with browser sessions is never woken on their behalf.
- Host-only observability: `sessions()` lists named sessions that currently own a browser, with timestamps and a `live` / `expired` status. `expired` means no recorded activity for a full `keep_alive` window, so the platform has most likely reclaimed the browser; it is a best guess, because a human driving the browser through Live View keeps it alive without updating the record. Closed names are not listed. `liveView(name, { mode })` creates fresh Live View URLs (valid ~5 minutes to connect, never persisted) for a live named session and returns `undefined` for absent, closed, or dead ones. Creating a link counts as activity, and a link that loses a race with `close` reports the session gone rather than returning dead URLs. The Live View helpers live in `browser/live-view.ts`, shared with the connector.

When `BrowserSessions` is exported (planned once the Lifecycle API firms up and the capability is in use), this is the example destined for `docs/agents/lifecycle.md` § Reusable capabilities, in that page's install style:

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { BrowserSessions } from "agents/browser"; // once exported

export class ResearchObject extends DurableObject<Env> {
  readonly browser = new BrowserSessions({
    browser: this.env.BROWSER,
    create: { guardrails: { allowedDomains: ["docs.example.com"] } }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.browser);

  async onRequest(_request: Request): Promise<Response> {
    // First call launches the browser; later calls reattach to it.
    const { cdp, restarted } = await this.browser.connect("research");
    if (restarted) {
      // Fresh browser — prior page state is gone; re-navigate before use.
    }
    try {
      await cdp.send("Page.navigate", { url: "https://docs.example.com" });
    } finally {
      cdp.close(); // detaches the socket; the named browser stays alive
    }
    return new Response("done");
  }
}
```

On an `Agent` subclass the only difference is installation — the Agent already owns a lifecycle, so the constructor runs `this.lifecycle.use(this.browser)` instead of `Lifecycle.install(this)`. The store needs no wiring in either style.

## Key decisions

- **Raw CDP remains the model interaction surface.** A typed verb API was prototyped and parked until evaluations can show it beats raw CDP (see the `park/browser-interaction-contract` branch).
- **Session identity is host-named, not model-promoted.** The connector's `dynamic` mode let the model promote a session; here the host wires a name and the core owns attachment. Recreation is loud (`restarted`), never silent.
- **Browser Run owns idle reclamation.** An earlier version swept idle sessions from a Lifecycle job. It duplicated `keep_alive`, woke idle objects, needed its own crash-recovery and race handling, and could delete a browser a human was driving through Live View, since that traffic bypasses the host. Dead-browser detection in `resolve` already covers correctness.
- **The connector is untouched.** Its `reuse`/`dynamic` modes overlap the session core for now; the overlap is bounded and resolves when the model surface moves onto the core.

## Tradeoffs

- Temporary duplication between connector session modes and the named session core.
- Without a sweep, records of expired browsers stay in storage until the name is next resolved or closed, and `sessions()` status is inferred from timestamps rather than asked of the platform. Browser Run can list active sessions if exact status is ever needed.
- A host that wants idle browsers reclaimed sooner than 10 minutes lowers `keepAliveMs` rather than relying on a sweep.
- Retired markers (`browser:retired:<name>`) are never deleted, so storage grows with the number of distinct names a host has ever used. Names are host-chosen and few in practice; per-user or per-task names would need an explicit forget operation.

## Relationship to browser-tools.md

[browser-tools.md](./browser-tools.md) describes the model-facing tools: the original `createBrowserTools` connector and `createBrowserExecuteTool`, which drives a `BrowserSessions` named browser. This document describes the session layer beneath the latter. The two share `browser-run.ts`, the session stores, and `live-view.ts`.
