# Browser Tools

**Status:** experimental (`agents/browser`)

## Problem

Agents need full Chrome DevTools Protocol access — navigation, DOM reads, screenshots, network inspection — without shipping a generated protocol bundle, without handing LLM-generated code a raw network capability, and with one browser whose tabs, cookies, and logins carry over between turns, hibernation, and restarts.

## How It Works

`browserTool` gives the model one browser that stays open between runs, so tabs, cookies, and logins carry over. The host owns the browser: it creates one `Browser` ([browser-sessions.md](./browser-sessions.md)), installs it on its Lifecycle, and passes it in with a Worker Loader binding: `browserTool({ browser, loader })`. A tool rebuilt every turn still reaches the same browser. The model can't start, close, or reset it.

There are three `browserTool`s, one per harness: `agents/browser/ai-sdk`, `agents/browser/tanstack-ai`, and `agents/browser/pi`. All three wrap `createBrowserToolCore` (`browser/browser-tool.ts`), which builds the description and runs the code. The adapters differ only in what they hand the model and the host (see [Adapters](#adapters)).

### A run

1. `execute(input, scope)` queues the run behind earlier runs in the same scope on the same `Browser`. The queue lives in the isolate and is keyed by the `Browser` object, so separately built tools share it. Runs in different scopes run in parallel over their own CDP connections, which Browser Run allows.
2. The run opens a `BrowserSession` on the browser for its scope.
3. `runBrowserCode` (`browser/sandbox.ts`) loads the model's code into a fresh Dynamic Worker from `loader`, with no bindings and `globalOutbound: null`. Its only way out is a `cdp` global whose calls go over RPC to the session. The run times out after `timeoutMs` (60 seconds by default).
4. A screenshot result is kept whole. Any other result has base64 payloads redacted and is cut to about 24,000 characters.
5. `session.close()` saves the scope's active tab, closes the CDP connection, and returns a report of what happened to the browser.
6. The tool returns `{ status, executionId, result | error, logs?, notice?, restarted?, newTabs? }`. Errors are returned, not thrown, so the model can read them and try again.

### The `cdp` global

- `cdp.send({ method, params?, sessionId?, timeoutMs? })` sends a CDP command and returns its result.
- `cdp.attachToTarget({ targetId })` makes an open tab active and returns a `sessionId` that keeps working in later runs.
- `cdp.spec()` returns the whole protocol (about 650 KB), fetched from the live browser, normalized, and cached per binding in the isolate.
- `cdp.getDebugLog()` and `cdp.clearDebugLog()` read and clear recent CDP traffic.

There is nothing for starting, closing, or resetting browsers. The tool's description documents these functions and lists rules for the CDP mistakes models commonly make, so the model needs no discovery pass.

### `BrowserSession`

`BrowserSession` (`browser/session.ts`, also available as `browser.session({ scope })`) is one run's connection to the browser. It connects on its first call and holds the rules that make CDP usable from model code:

- **`sessionId: "active"`** points at the tab the scope is working in. The `Browser` stores each scope's active tab, so it carries over between runs. Opening a tab with `Target.createTarget` or switching with `cdp.attachToTarget` changes it. A scope with no open tab of its own gets a new blank tab, never one already open (even a blank one could be another scope's, or a popup), so Browser Run's initial blank tab goes unused.
- **One active tab per scope.** Conversations sharing one `Browser` pass different `scope`s and stay in their own tabs; cookies and logins are shared. The report says when another scope closed the scope's tab (`tabClosed`) or is working in it too (`tabShared`).
- **Popups don't take over.** Tabs the page opens itself are reported as `newTabs`, and the model decides whether to switch.
- **A lost browser doesn't stop the run.** If the browser expired, was closed, or crashed, connecting replaces it and the code runs in the new one. The report says `restarted`.
- **The model can't close the browser.** `Browser.close` and `Browser.crash*` are refused.
- **Helpful errors.** Each function checks its arguments, and common CDP errors come back with a fix: a page command sent without `sessionId`, a CDP session id from an earlier run, an event sent as a command.
- **Screenshots over 1 MB fail** with a hint to capture the viewport or use JPEG (see [Key Decisions](#key-decisions)).

The tool turns the report into fields on the result: `restarted: true`, `newTabs`, and a `notice` with a sentence for each of restarted, tab closed, and tab shared.

### Code shapes

The tool asks for an async arrow function. The sandbox loads the code as an expression first, and if that doesn't parse, once more as a function body. Codemode's `acorn`-based normalizer also returned a snippet's last expression. The sandbox doesn't parse the code, so a function body that comes back `undefined` gets a `notice` telling the model to `return` the value.

### Adapters

- **AI SDK** returns a tool object; the host picks its name, e.g. `tools: { browser: browserTool(...) }`. Its `toModelOutput` turns a screenshot into a short text summary for the model, plus any `notice` and `newTabs`; the full output, image included, stays on the message for the UI.
- **TanStack AI** returns a `ServerTool` named `browser` unless `name` is passed. TanStack AI gives the host and the model the same output, so a screenshot is replaced by a note, and the description tells the model to read the page with `Runtime.evaluate` instead.
- **pi** returns a pi tool named `browser` unless `name` is passed. A screenshot comes back as an image part the model can see. `scope` defaults to the calling conversation, so sessions, forks, and subagents don't drive each other's tab. The tool is marked `replay: "unsafe"`, so a call cut off by an eviction isn't rerun; the model gets an interrupted result.

### Live View

Live View is for the host. It calls `browser.liveView()` to give a person a link into the same browser. The agent can end its turn and pick up after the person is done.

## Key Decisions

- **One browser, owned by the host.** The host creates a `Browser` and passes it in; the tool doesn't start, close, or reset browsers, and the model can't either.
- **No codemode.** Each run is a fresh Dynamic Worker with `globalOutbound: null`. Codemode's replay log mattered for pausing inside a run (approvals, handoffs); handing the browser to a person now ends the turn instead, via the host's `browser.liveView()`.
- Do not bundle the CDP spec; fetch it from the live browser and normalize it.
- Keep browser state host-side. The sandbox gets RPC functions only.
- **One active tab per scope**, with runs in a scope queued, so conversations sharing a browser don't fight over a tab.
- **Screenshots over 1 MB fail with a hint.** They're kept whole in the chat message for the UI, and a stored message must fit SQLite's 2 MB row, or the image is compacted away. Failing early lets the model take a smaller one. Other results are cut to about 24,000 characters before they're stored, so they need no limit.

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
