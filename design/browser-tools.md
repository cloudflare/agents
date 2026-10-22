# Browser Tools

**Status:** experimental (`agents/browser`)

## Problem

Agents need full Chrome DevTools Protocol access — navigation, DOM reads, screenshots, network inspection — without shipping a generated protocol bundle, without handing LLM-generated code a raw network capability, and with one browser whose tabs, cookies, and logins carry over between turns, hibernation, and restarts.

## How It Works

`browserTool({ browser, loader })` gives the model one browser that stays open between runs. Tabs, cookies, and logins carry over. The host owns the browser: it creates one `Browser` ([browser-sessions.md](./browser-sessions.md)) and passes it in, so a tool rebuilt every turn still reaches the same browser. It returns a single AI SDK tool; the host picks its name, e.g. `tools: { browser: browserTool(...) }`. It doesn't use codemode: each run's code runs in a fresh Dynamic Worker from `loader` (`browser/sandbox.ts`), with no network access and a `cdp` object backed by a `BrowserSession`.

The model gets a `cdp` global (`send`, `attachToTarget`, `spec`, `getDebugLog`, `clearDebugLog`), minus anything for starting, closing, or resetting browsers.

- **`sessionId: "active"`** points at the tab the agent is working in, and it stays the same across runs. Opening a tab with `Target.createTarget` or switching with `attachToTarget` changes it. A scope with no open tab of its own gets a new blank tab, never one already open (even a blank one could be another scope's, or a popup), so Browser Run's initial blank tab goes unused. When someone else closed the scope's tab, the next run says so.
- **One active tab per scope.** `browserTool({ scope })` keeps conversations sharing one `Browser` in their own tabs; cookies and logins stay shared. Each run opens its own session in its scope. Runs in one scope are queued (per `Browser` object, so tools rebuilt each turn share the queue); different scopes run in parallel over their own CDP connections, which Browser Run allows. The result's `notice` says when another scope is working in the model's tab too.
- **Popups don't take over.** Tabs the page opens itself come back as `newTabs` in the result, and the model decides whether to switch.
- **A lost browser doesn't stop the run.** If the browser had to be replaced, the code still runs in the new one, and the result includes `restarted: true` and a `notice` that earlier tabs and logins are gone.
- **The model can't close the browser.** `Browser.close` and `Browser.crash*` are refused; the host decides when the browser ends.
- **Helpful errors.** A page command sent without `sessionId` explains how to fix it.
- **Live View is for the host.** The host calls `browser.liveView()` to give a person a link into the same browser. The agent can end its turn and pick up after they're done.

`BrowserSession` (`browser/session.ts`, from `browser.session({ scope })`) holds all of this: it opens a CDP connection on its first call, and `close()` saves the scope's active tab, closes the connection and returns the report (`restarted`, `newTabs`, `tabClosed`, `tabShared`). `browserTool` opens one per run.

The sandbox loads the model's code as an expression first (the tool asks for an async arrow function), and if that doesn't parse, once more as a function body. Codemode's `acorn`-based normalizer also returned a snippet's last expression; the sandbox doesn't parse the code, so statements with no `return` come back with a `notice` telling the model to return the value.

## Key Decisions

- **One browser, owned by the host.** The host creates a `Browser` and passes it in; the tool doesn't start, close, or reset browsers, and the model can't either.
- **No codemode.** Each run is a fresh Dynamic Worker with `globalOutbound: null`. Codemode's replay log mattered for pausing inside a run (approvals, handoffs); handing the browser to a person now ends the turn instead, via the host's `browser.liveView()`.
- Do not bundle the CDP spec; fetch it from the live browser and normalize it.
- Keep browser state host-side. The sandbox gets RPC functions only.
- **One active tab per scope**, with runs in a scope queued, so conversations sharing a browser don't fight over a tab.
- **Screenshots over 1 MB fail with a hint.** They're kept whole in the chat message for the UI, and a stored message must fit SQLite's 2 MB row, or the image is compacted away. Other results are cut to a preview before they're stored, so they have no limit.

## Tradeoffs

- No pause inside a run: a human handoff ends the turn, and the agent picks up after.
- No `calls` audit log on the result.
- Runtime spec fetches add latency over a bundled JSON; a per-binding in-memory cache keeps it to one fetch per isolate.
- A snippet's last expression isn't returned, to avoid a parser dependency; the `notice` covers it.

## Verification

`browser-session.test.ts` covers `BrowserSession`'s tab handling, scopes, popups, restarts, and errors. `browser-capability.test.ts` runs `browserTool` end to end on an Agent, including the code shapes the sandbox accepts, errors, logs and timeouts. The real-Chrome suite (`src/browser-tests/`) covers the active tab across runs, popups, detach and reattach, the refused `Browser.close`, and restarts.

# Deprecated

## Codemode connector

`createBrowserTools`, `createBrowserRuntime`, and `BrowserConnector` are deprecated in favour of `browserTool` and won't change. This section records how they work for existing users.

### How it works

Browser access is a **codemode connector**. `BrowserConnector` (namespace `cdp`) plugs into a `CodemodeRuntime` — the durable execution facet from `@cloudflare/codemode` — so the model writes TypeScript against `cdp.*` inside the sandbox and every call is recorded in the runtime's abort-and-replay log:

- `cdp.send(args)` issues a CDP command over a host-side WebSocket; `cdp.attachToTarget` attaches to a page target; `cdp.spec` queries the live protocol description (fetched from the browser, normalized, cached per binding). Normalization keeps parameters, return values, and type properties, and domain-qualifies every `$ref` so it matches a type's `name`.
- `cdp.startSession` / `cdp.sessionInfo` / `cdp.closeSession` / `cdp.resetSession` manage session lifetime from inside the sandbox; `getDebugLog` / `clearDebugLog` aid debugging.
- `cdp.getLiveViewUrl({ targetId?, mode? })` returns a [Live View](https://developers.cloudflare.com/browser-run/features/live-view/) link for a tab — a URL a human can open to watch and control the session in real time. The sandbox uses it for human-in-the-loop handoffs: surface the link, then make an approval-gated call so the run pauses (the codemode runtime's durable pause/approve) until the human is done. It's a `reexecute` read — the URL is ephemeral (~5 min) so it must never be pinned in the replay log.
- The sandbox never holds the socket. It sees a typed RPC surface; the WebSocket, the Browser Rendering session, and all session bookkeeping stay on the host.

`createBrowserTools(options)` returns `{ browser_execute }` — one durable tool. `createBrowserRuntime(options)` additionally exposes the runtime handle (approvals, audit, snippets) and the connector (host-side `sessionInfo()` / `liveView()` / `closeSession()` / `sweep()`). `connector.liveView()` returns the shared (reuse/promoted) session's Live View URLs so the _host_ (e.g. an agent UI or a Slack notification) can hand a human a link into a long-lived session.

#### Live View (human-in-the-loop)

Live View rides data that's already in the protocol: every target in a Browser Run session carries a `devtoolsFrontendUrl` (a `live.browser.run` link). The connector exposes it two ways — `cdp.getLiveViewUrl()` for autonomous handoffs from inside a run, and `connector.liveView()` for host-driven handoffs into the shared session — and optionally rewrites the hosted UI's `mode` query param (`tab` for an interactive page view, `devtools` for the full inspector). Because the codemode runtime already supports pausing a run for approval _with the browser session intact_, "human in the loop" is just: get the URL → surface it → make an approval-gated call → resume after the human acts. No new pause machinery is needed.

#### Session lifecycle

Sessions are acquired against the Browser Rendering binding's REST API (`browser-run.ts`) and tracked in a `BrowserSessionStore` (`DurableBrowserSessionStore` over the DO's storage by default). Three modes:

- **one-shot** (default): a fresh session per codemode execution, stored under `cdp:exec:<executionId>`, torn down in the connector's `disposeExecution` when the execution reaches a terminal status.
- **reuse**: a named session under `cdp:reuse:<key>`, shared across executions; cleaned only by explicit `closeSession` or `sweep()`.
- **dynamic**: starts one-shot; the model can promote the session with `cdp.startSession()`, which moves it to the reuse keyspace so later executions continue in the same browser.

Kitesurf can be selected through the session options, but it does not use this session state machine. A Kitesurf browser is the direct `/v1/devtools/browser?browser=kitesurf` WebSocket itself: there is no POST acquire, reconnectable session id, or delete-by-id lifecycle. The current connector keeps that socket only for the current pass and therefore exposes Kitesurf as one-shot: it rejects reuse, dynamic sessions, pause/resume, Live View, recording, and keep-alive rather than silently degrading those requests.

That one-shot restriction is an Agents SDK policy, not proof that Kitesurf cannot preserve state across codemode calls. A future connector could pin the WebSocket in the owning Agent/Durable Object instance and route later executions through the same connection. Tabs, cookies, and page state would survive while that instance and socket remained alive. This would be a weaker, **connection-pinned** or **best-effort reuse** mode—not Browser Run's durable `reuse` mode—because it could not survive socket loss, Durable Object eviction or restart, deployment, or reconnect from storage. It would also need explicit ownership, idle cleanup, concurrency serialization, and loud failure semantics instead of silently opening a fresh browser after connection loss. Keeping the socket open could similarly span a short codemode pause, but not provide the durable long-wait guarantee of a reconnectable Browser Run session. Preserving the socket would not add Live View: Kitesurf exposes neither the session-scoped target routes nor the `Cloudflare.getLiveView` command needed to mint a Live View URL.

Because `disposeExecution` fires only on terminal transitions — never on pause — a session survives an approval pause by design. The stage-1 `onPassEnd` hook closes the cached WebSocket and releases the per-execution lease at the end of every pass (including pauses); on resume the connector reconnects from the stored session id.

#### Pauses, replay, and attach handles

CDP session ids from `Target.attachToTarget` are scoped to one WebSocket connection, but the runtime's log must replay across reconnects. The connector therefore returns stable **attach handles** (`target:<targetId>`) instead of raw session ids and transparently re-attaches when a handle is used on a new connection — resumed code keeps working without knowing the socket changed. In the persistent-browser connector, a raw `Target.attachToTarget` sent through `cdp.send` still returns Chrome's own id, which only lasts for that run; `Target.detachFromTarget` also accepts a handle.

If Browser Rendering expires a session while a pause waits for a human, the resume surfaces a model-facing error ("browser session expired while awaiting approval") and cleans up the stale store entry.

#### Cleanup backstops

- `runtime.expirePaused()` (codemode) handles the orderly case: stale never-approved pauses (and runs stuck `running` after a host crash) are expired and `disposeExecution` reclaims their sessions.
- `connector.sweep()` is the crash backstop — call it from a scheduled task. Shared `cdp:reuse:*` entries are swept after `maxIdleMs` (default 10 min). Per-execution `cdp:exec:*` entries use a much longer window (`maxExecIdleMs`, default 24h — at least the runtime's paused TTL) and are touched on use, so an active or paused-awaiting-approval run is never swept out from under the runtime. A swept exec entry leaves a `closedAt` tombstone so a later resume fails with a clear "expired or was swept" error instead of silently continuing in a fresh browser.

### Key decisions

- **Connector, not bespoke tools.** Riding the codemode runtime buys durability (abort-and-replay, approvals pausing _inside_ a run with the session intact), the discovery surface (`codemode.search`/`describe`), and snippets — none of which the old provider-injection path had.
- Do not bundle the CDP spec; fetch it from the live browser and normalize it (always `name`, `method`/`event`, concrete arrays), memoized per binding.
- Keep browser state host-side. The sandbox gets RPC helpers only.
- Store session ids durably, keyed by execution (one-shot) or name (reuse), so any isolate can resolve them after hibernation.
- Sequential CDP calls only (instructions tell the model not to `Promise.all` connector calls) — replay ordering must be deterministic.
- Short-held locks around store mutations only; sockets are cached per execution with idle-disconnect as a backstop.

### Tradeoffs

- Runtime spec fetches add latency over a bundled JSON; a per-binding in-memory cache keeps it to one fetch per isolate.
- Stable attach handles add a host-side mapping layer, but make pause/resume invisible to model code.
- The local `wrangler dev` Browser Rendering simulator differs from production (DELETE is a no-op, lifecycle events are unreliable), so e2e assertions validate store-level state and simulate expiry at the storage layer.

### Verification

Unit tests (`browser-connector.test.ts`) cover executionId keying, `disposeExecution` idempotency, `onPassEnd` socket release, sweep over both keyspaces (including exec tombstones, touch-on-use, and the loud resume failure after a sweep), concurrent connect dedupe, and the expired-session error. End-to-end tests (`src/browser-tests/`, run via `pnpm run test:browser` — spawns real `wrangler dev` with `browser` + `LOADER` bindings and Chromium) cover one-shot dispose-on-terminal, dynamic promotion surviving terminal, reuse + sweep, survive-a-pause (session intact across approve), the sequential-calls divergence guard, and a concurrent-socket probe.
