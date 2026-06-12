---
"agents": minor
---

Rebuild `agents/browser` on the codemode connector runtime (experimental).

The browser tool surface is now a single durable tool, **`browser_execute`**: the model writes sandboxed code against a `cdp` connector (`cdp.send`, `cdp.attachToTarget`, `cdp.spec`, `cdp.getDebugLog`, …) instead of picking from several flat tools. Executions are recorded on a `CodemodeRuntime` Durable Object facet with abort-and-replay, so a run can pause for approval and resume with its browser session, tabs, and cookies intact.

- **`BrowserConnector`** — a `CodemodeConnector` (name `cdp`) that owns CDP sockets keyed by execution id. Sockets are released at the end of every execution pass (`onPassEnd`); browser sessions are torn down on terminal status (`disposeExecution`) — never on pause.
- **Session modes** — `one-shot` (default, fresh session per execution), `reuse` (named shared session), and `dynamic` (starts one-shot; the model can promote with `cdp.startSession()` after e.g. logging in). Shared sessions are tracked in durable storage and survive hibernation; `connector.sweep()` reclaims expired ones from a scheduled task.
- **Safe sweeping** — per-execution entries are touched on use and only swept after `maxExecIdleMs` (default 24h, matching the runtime's paused TTL), so a run awaiting approval keeps its browser. A swept entry leaves a tombstone so a later resume fails with a clear "expired or was swept" error instead of silently continuing in a fresh browser. Concurrent CDP calls share one in-flight socket connect instead of leaking the loser's WebSocket. Session-store locks wrap storage operations only — liveness probes and session create/delete happen outside the lock (with a commit re-check; a racing create's redundant session is deleted), so a hung Browser Rendering call can't serialize other session operations.
- **Stable attach handles** — `cdp.attachToTarget` returns `{ sessionId }` where the id is a stable handle bound to the target (not a raw CDP session id), so handles recorded before a pause still work after the resume reconnects. The object shape mirrors the real `Target.attachToTarget` response, which is what models expect.
- **Model-actionable CDP errors** — a "method wasn't found" failure on a `send` without a sessionId explains that page-scoped commands need `cdp.attachToTarget` first, and a missing `targetId` explains how to list/create targets.
- **`createBrowserTools({ ctx, browser, loader, session? })`** (AI SDK and TanStack AI variants) now requires the hosting Durable Object's `ctx` and returns `{ browser_execute }`; `createBrowserRuntime` additionally exposes the runtime handle and connector for host-side wiring (approvals, `sessionInfo`/`closeSession`/`sweep`). The previous `browser_search`/flat-tool surface and `createBrowserProvider` are removed.
- Worker entries must export the facet class: `export { CodemodeRuntime } from "agents/browser"`.

`agents/chat` gains `pausedExecutionUpdate`, a tool-part update that replaces a paused execution's output in the transcript with its resolved outcome (completed / rejected / paused again) — the transcript-side half of human-in-the-loop approvals for durable executions.
