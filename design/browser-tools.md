# Browser Tools

**Status:** experimental (`agents/browser`)

> Two tool paths share this page. `createBrowserExecuteTool` (below, [Persistent browser tool](#persistent-browser-tool)) drives one host-named browser that persists between executions, built on the session layer in [browser-sessions.md](./browser-sessions.md). `createBrowserTools` and its `BrowserConnector` modes are the original path and stay unchanged; the rest of this page describes them.

## Problem

Agents need full Chrome DevTools Protocol access — navigation, DOM reads, screenshots, network inspection — without shipping a generated protocol bundle, without handing LLM-generated code a raw network capability, and with browser sessions that survive the pauses a durable agent naturally takes (approvals, hibernation, long waits).

## How It Works

Browser access is a **codemode connector**. `BrowserConnector` (namespace `cdp`) plugs into a `CodemodeRuntime` — the durable execution facet from `@cloudflare/codemode` — so the model writes TypeScript against `cdp.*` inside the sandbox and every call is recorded in the runtime's abort-and-replay log:

- `cdp.send(args)` issues a CDP command over a host-side WebSocket; `cdp.attachToTarget` attaches to a page target; `cdp.spec` queries the live protocol description (fetched from the browser, normalized, cached per binding).
- `cdp.startSession` / `cdp.sessionInfo` / `cdp.closeSession` / `cdp.resetSession` manage session lifetime from inside the sandbox; `getDebugLog` / `clearDebugLog` aid debugging.
- `cdp.getLiveViewUrl({ targetId?, mode? })` returns a [Live View](https://developers.cloudflare.com/browser-run/features/live-view/) link for a tab — a URL a human can open to watch and control the session in real time. The sandbox uses it for human-in-the-loop handoffs: surface the link, then make an approval-gated call so the run pauses (the codemode runtime's durable pause/approve) until the human is done. It's a `reexecute` read — the URL is ephemeral (~5 min) so it must never be pinned in the replay log.
- The sandbox never holds the socket. It sees a typed RPC surface; the WebSocket, the Browser Rendering session, and all session bookkeeping stay on the host.

`createBrowserTools(options)` returns `{ browser_execute }` — one durable tool. `createBrowserRuntime(options)` additionally exposes the runtime handle (approvals, audit, snippets) and the connector (host-side `sessionInfo()` / `liveView()` / `closeSession()` / `sweep()`). `connector.liveView()` returns the shared (reuse/promoted) session's Live View URLs so the _host_ (e.g. an agent UI or a Slack notification) can hand a human a link into a long-lived session.

### Live View (human-in-the-loop)

Live View rides data that's already in the protocol: every target in a Browser Run session carries a `devtoolsFrontendUrl` (a `live.browser.run` link). The connector exposes it two ways — `cdp.getLiveViewUrl()` for autonomous handoffs from inside a run, and `connector.liveView()` for host-driven handoffs into the shared session — and optionally rewrites the hosted UI's `mode` query param (`tab` for an interactive page view, `devtools` for the full inspector). Because the codemode runtime already supports pausing a run for approval _with the browser session intact_, "human in the loop" is just: get the URL → surface it → make an approval-gated call → resume after the human acts. No new pause machinery is needed.

### Session lifecycle

Sessions are acquired against the Browser Rendering binding's REST API (`browser-run.ts`) and tracked in a `BrowserSessionStore` (`DurableBrowserSessionStore` over the DO's storage by default). Three modes:

- **one-shot** (default): a fresh session per codemode execution, stored under `cdp:exec:<executionId>`, torn down in the connector's `disposeExecution` when the execution reaches a terminal status.
- **reuse**: a named session under `cdp:reuse:<key>`, shared across executions; cleaned only by explicit `closeSession` or `sweep()`.
- **dynamic**: starts one-shot; the model can promote the session with `cdp.startSession()`, which moves it to the reuse keyspace so later executions continue in the same browser.

Kitesurf can be selected through the session options, but it does not use this session state machine. A Kitesurf browser is the direct `/v1/devtools/browser?browser=kitesurf` WebSocket itself: there is no POST acquire, reconnectable session id, or delete-by-id lifecycle. The current connector keeps that socket only for the current pass and therefore exposes Kitesurf as one-shot: it rejects reuse, dynamic sessions, pause/resume, Live View, recording, and keep-alive rather than silently degrading those requests.

That one-shot restriction is an Agents SDK policy, not proof that Kitesurf cannot preserve state across codemode calls. A future connector could pin the WebSocket in the owning Agent/Durable Object instance and route later executions through the same connection. Tabs, cookies, and page state would survive while that instance and socket remained alive. This would be a weaker, **connection-pinned** or **best-effort reuse** mode—not Browser Run's durable `reuse` mode—because it could not survive socket loss, Durable Object eviction or restart, deployment, or reconnect from storage. It would also need explicit ownership, idle cleanup, concurrency serialization, and loud failure semantics instead of silently opening a fresh browser after connection loss. Keeping the socket open could similarly span a short codemode pause, but not provide the durable long-wait guarantee of a reconnectable Browser Run session. Preserving the socket would not add Live View: Kitesurf exposes neither the session-scoped target routes nor the `Cloudflare.getLiveView` command needed to mint a Live View URL.

Because `disposeExecution` fires only on terminal transitions — never on pause — a session survives an approval pause by design. The stage-1 `onPassEnd` hook closes the cached WebSocket and releases the per-execution lease at the end of every pass (including pauses); on resume the connector reconnects from the stored session id.

### Pauses, replay, and attach handles

CDP session ids from `Target.attachToTarget` are scoped to one WebSocket connection, but the runtime's log must replay across reconnects. The connector therefore returns stable **attach handles** (`target:<targetId>`) instead of raw session ids and transparently re-attaches when a handle is used on a new connection — resumed code keeps working without knowing the socket changed.

If Browser Rendering expires a session while a pause waits for a human, the resume surfaces a model-facing error ("browser session expired while awaiting approval") and cleans up the stale store entry.

### Cleanup backstops

- `runtime.expirePaused()` (codemode) handles the orderly case: stale never-approved pauses (and runs stuck `running` after a host crash) are expired and `disposeExecution` reclaims their sessions.
- `connector.sweep()` is the crash backstop — call it from a scheduled task. Shared `cdp:reuse:*` entries are swept after `maxIdleMs` (default 10 min). Per-execution `cdp:exec:*` entries use a much longer window (`maxExecIdleMs`, default 24h — at least the runtime's paused TTL) and are touched on use, so an active or paused-awaiting-approval run is never swept out from under the runtime. A swept exec entry leaves a `closedAt` tombstone so a later resume fails with a clear "expired or was swept" error instead of silently continuing in a fresh browser.

## Persistent browser tool

`createBrowserExecuteTool({ sessions, loader, session?, timeoutMs?, ctx? })` returns `{ browser_execute }` over `BrowserSessionConnector` (`browser/session-connector.ts`, namespace `cdp`). It keeps the codemode runtime (recorded calls, audit, snippets, discovery) but replaces who owns the browser: the host installs one `BrowserSessions` capability on its Lifecycle and passes it in, so tools rebuilt every turn all reach the same named browser. Browser Run (Chromium) only; guardrails, `keepAliveMs`, and recording are configured on the capability. Each session name gets its own codemode runtime (`browser-session_<name>`), so its execution history never mixes with `createBrowserTools`.

The model surface is `send`, `attachToTarget`, `spec`, `getDebugLog`, and `clearDebugLog`. There is nothing to start, close, reset, or promote.

- **One browser across executions.** The first CDP call in a pass calls `sessions.connect(name)`; the socket closes at pass end and the browser stays up.
- **`sessionId: "active"`** addresses the tab the agent is working in. CDP session ids die with each socket, so the tab's `targetId` is stored on the named session record (`activeTargetId`). On first use in a pass, `"active"` resolves to the stored tab if it is still open, else the only open tab, else a new blank tab when none are open, else the first listed tab. `Target.createTarget` and `attachToTarget` (or raw `Target.attachToTarget`) make that tab active; closing the active tab makes the next `"active"` pick again. The pass saves its active tab at pass end, and writes only while the record still holds the same browser, so a stale pass cannot resurrect a closed session.
- **Popups do not steal focus.** Tabs the page opened itself (present at pass end, absent at pass start, not created by the agent) come back as `newTabs: [{ targetId, url, title }]`; the model decides whether to switch. Tab switches a human makes in Live View are invisible to the tool.
- **Restarts are loud but not blocking.** If the browser had to be replaced, the code still runs in the fresh browser and the result adds `restarted: true` plus a `notice` that earlier tabs, logins, and page state are gone. `NamedBrowserSessions.connect` also covers expiry between its liveness probe and the WebSocket upgrade: a 404/410 upgrade retires the record and resolves once more rather than failing.
- **Teaching errors.** A page-scoped command sent without a session fails with instructions to pass `sessionId: "active"`; sending a CDP event as a command explains that events cannot be sent.
- **Live View is a host concern.** The tool exposes no `getLiveViewUrl`; hosts call `sessions.liveView(name)` to hand a human a link into the same persistent browser. The session outlives the turn, so the agent can end its turn and continue after the human is done.

`restarted` and `newTabs` travel from the connector to the tool through a per-execution report (`takeReport(executionId)`) read once the run returns. The report map is bounded in case a caller runs the runtime without reading it.

## Key Decisions

- **Connector, not bespoke tools.** Riding the codemode runtime buys durability (abort-and-replay, approvals pausing _inside_ a run with the session intact), the discovery surface (`codemode.search`/`describe`), and snippets — none of which the old provider-injection path had.
- Do not bundle the CDP spec; fetch it from the live browser and normalize it (always `name`, `method`/`event`, concrete arrays), memoized per binding.
- Keep browser state host-side. The sandbox gets RPC helpers only.
- Store session ids durably, keyed by execution (one-shot) or name (reuse), so any isolate can resolve them after hibernation.
- Sequential CDP calls only (instructions tell the model not to `Promise.all` connector calls) — replay ordering must be deterministic.
- Short-held locks around store mutations only; sockets are cached per execution with idle-disconnect as a backstop.

## Tradeoffs

- Runtime spec fetches add latency over a bundled JSON; a per-binding in-memory cache keeps it to one fetch per isolate.
- Stable attach handles add a host-side mapping layer, but make pause/resume invisible to model code.
- The local `wrangler dev` Browser Rendering simulator differs from production (DELETE is a no-op, lifecycle events are unreliable), so e2e assertions validate store-level state and simulate expiry at the storage layer.

## Verification

`browser-session-connector.test.ts` covers the persistent tool's active-tab resolution order, persistence across executions, `Target.createTarget`/`attachToTarget` switching, popup reporting, closed-tab recovery, restart reporting, teaching errors, and argument validation. `browser-capability.test.ts` runs `createBrowserExecuteTool` end to end on an Agent with `BrowserSessions` installed, through a real codemode runtime facet and sandbox.

Unit tests (`browser-connector.test.ts`) cover executionId keying, `disposeExecution` idempotency, `onPassEnd` socket release, sweep over both keyspaces (including exec tombstones, touch-on-use, and the loud resume failure after a sweep), concurrent connect dedupe, and the expired-session error. End-to-end tests (`src/browser-tests/`, run via `pnpm run test:browser` — spawns real `wrangler dev` with `browser` + `LOADER` bindings and Chromium) cover one-shot dispose-on-terminal, dynamic promotion surviving terminal, reuse + sweep, survive-a-pause (session intact across approve), the sequential-calls divergence guard, and a concurrent-socket probe.
