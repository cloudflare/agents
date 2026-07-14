# 27 — Cloudflare adapters: hosting the rebuild on real Durable Objects

**Adapter wave.** Every port has an in-memory reference adapter and the
domain has 1,048 passing tests against them — but zero proof yet that the port
contracts are a *faithful abstraction* of real DO/workerd behavior. This doc
specs the production adapters under `src/adapters/cloudflare/` plus the
workerd test rig that closes that gap.

Standing constraints:

1. **No domain changes.** `src/app/`, `src/domain/`, `src/kernel/` are frozen
   for this wave. If an adapter can't be written against a port as specced,
   that's a finding to surface, not a license to widen the port.
2. **Ports stay frozen too.** Every impedance mismatch found so far (sync
   `AlarmTimer.get()` vs async `storage.getAlarm()`, etc.) is solvable inside
   the adapter; the resolutions are specced below.
3. Only `src/adapters/cloudflare/**`, `test-workers/**`, `demo/cloudflare/**`,
   and tooling config are touched. The banned-token test and the node test
   suite must pass unchanged.
4. `cf_agent_*` frames stay in `adapters/websocket-chat/` — the Cloudflare
   shell *hosts* that adapter, it does not reimplement the protocol.

Decisions (resolved with the user, 2026-07-14):

- **Sub-agents use facets** (`ctx.facets` + `ctx.exports`), accepting the
  experimental-flag dependency; the root multiplexes child alarms (§6).
- **A minimal runnable demo worker is in scope**, self-contained at
  `rebuild/demo/cloudflare/` (not `examples/`) — the real-infra counterpart
  of `demo/cli.ts` (§10, W4).
- **Client-package compat**: URL scheme + `cf_agent_*` frames are kept
  compatible by construction; a smoke test against the real `agents/react`
  client is deferred (revisit after W2).
- **Process**: implementation waves run through `codex exec` (gpt-5.5),
  each dispatched by a thin wrapper subagent (§11).

## The acceptance test for this wave

- The existing storage/alarm port contract tests (extracted into shared,
  factory-parameterized suites) pass against **real `ctx.storage` inside
  workerd**, not just the memory adapters.
- A `Think` subclass hosted in a real SQLite-backed Durable Object serves a
  full chat turn (FakeModel) over a **real WebSocket**, with connect-sync,
  streaming, and resume-from-offset after reconnect.
- The durable-work e2e story (schedules + fibers + queue surviving eviction)
  holds when "eviction" is a real fresh DO activation, driven by
  vitest-pool-workers' isolated-storage + fresh-stub machinery.
- `npm run test` (plain node) and `npm run typecheck` still pass with no
  workers types leaking into the base config.

## 0. Pinned platform facts

Verified against workers-types 4.20260629 and the monorepo's workerd test
setups (configuration facts, not clean-room-protected code):

- SQLite-backed DOs (`new_sqlite_classes` migration) expose synchronous
  `ctx.storage.sql.exec` and the synchronous `ctx.storage.kv` API.
- `ctx.storage.setAlarm/getAlarm/deleteAlarm` are async; the platform
  invokes `alarm()` with retries on throw (at-least-once).
- Hibernatable WebSockets: `ctx.acceptWebSocket(ws, tags)`,
  `ctx.getWebSockets(tag?)`, per-socket `serializeAttachment` /
  `deserializeAttachment` (survives hibernation; in-memory state does not),
  class-level `webSocketMessage` / `webSocketClose` handlers.
- **`ctx.id.name` is NOT populated inside the DO.** The instance name must
  arrive out-of-band and be persisted (§5, "Identity").
- Facets are experimental and absent from workers-types — declare minimal
  ambient types locally (`facets.d.ts`), covering exactly the calls we make
  (`facets.get/abort/delete`, `exports`). Facet child classes must be listed
  in `durable_objects.bindings` (so `ctx.exports` resolves them) but NOT in
  `new_sqlite_classes`.
- Toolchain pairing proven in the monorepo: vitest 4.1.x +
  `@cloudflare/vitest-pool-workers` ^0.16.20, wrangler ^4.105,
  `@cloudflare/workers-types` ^4.20260629; `compatibility_date: "2026-06-11"`
  with flags `["nodejs_compat", "enable_nodejs_tty_module",
  "enable_nodejs_fs_module", "enable_nodejs_http_modules",
  "enable_nodejs_perf_hooks_module", "enable_nodejs_v8_module",
  "enable_nodejs_process_v2"]` (the extra node flags exist for the vitest
  runner itself).

## 1. What already works on Workers unchanged

Not everything needs a new adapter. These are configuration notes, not code:

- **ModelClient**: the Anthropic adapter (`adapters/anthropic/model.ts`) is
  built on the official SDK's fetch-based streaming — it runs on Workers
  as-is. API key arrives via a secret binding instead of `process.env`.
  (Optional later: AI Gateway via `baseURL`; workers-ai as a second adapter.)
- **FetchLike**: workerd's global `fetch` satisfies the port with a ~10-line
  wrapper (headers→Map). A service-binding variant is the same wrapper over
  `binding.fetch`.
- **IdSource**: `crypto.randomUUID()` exists in workerd.
- **Clock**: `Date.now()`. Note workerd freezes time within an I/O-free
  stretch (Spectre mitigation); the scheduler only compares against alarm
  wakeups, which are themselves I/O, so this is benign — but the contract
  tests should include one schedule-fires-at-the-right-time case to prove it.

## 2. `DurableKeyValueStore` — the load-bearing adapter

The port is **synchronous**, ordered, prefix-scannable, JSON-valued
(`ports/storage.ts`). Two candidate substrates, both synchronous, both
requiring the DO class to be SQLite-backed (`new_sqlite_classes` migration):

- **Primary: `ctx.storage.kv`** — the synchronous KV API on SQLite-backed
  DOs (`kv.get/put/delete/list`). Near 1:1 with the port.
- **Fallback: one SQL table** via `ctx.storage.sql.exec` —
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  with `ORDER BY key` + escaped-`LIKE` (or `>= prefix AND < prefix~`) prefix
  scans, `JSON.stringify`/`parse` values, `rowsWritten` for delete counts.
  Use only if `storage.kv` semantics diverge from the contract (implementer
  verifies first; the contract suite is the arbiter).

Semantics the contract suite must pin against the real substrate:

- key ordering of `list()` (the port promises ordered-by-key; verify UTF-8
  lexicographic matches the memory adapter's sort),
- `list({ prefix, limit })` interaction,
- `delete()` boolean return and `deleteAll({ prefix })` count,
- value round-tripping: port says JSON-serializable; DO storage is
  structured-clone. JSON is a strict subset, so round-trip through the
  adapter must normalize (contract test proves `undefined`-in-object, nested
  arrays, etc. behave identically to the memory adapter).

Platform limits to document in the adapter header (not to engineer around
yet): 2 MiB per value on SQLite-backed DOs, key length limits. The event
log's chunk records are the only plausible offender and they're per-chunk
small.

**Durability note**: synchronous writes + workerd output gates mean no
`await` is needed for persistence-before-external-effects. This is exactly
the model the memory adapter assumed — state it in a comment; it's the whole
reason the port could be sync.

## 3. `DurableAlarmTimer` — sync port over an async slot

`AlarmTimer.get(): number | null` is sync; `ctx.storage.getAlarm()` is async.
Resolution: the adapter is the **only writer** of the alarm slot, so it keeps
an in-memory mirror:

- On activation the shell does
  `mirror = await ctx.storage.getAlarm()` inside `blockConcurrencyWhile`
  (before the agent constructor runs any scheduler code).
- `set(at)` → `mirror = at; void ctx.storage.setAlarm(at)` (fire-and-forget
  is safe under output gates).
- `clear()` → `mirror = null; void ctx.storage.deleteAlarm()`.
- `get()` → mirror.

The shell's `alarm()` handler clears the mirror (the slot has fired — DO
semantics), then calls `agent.onAlarm()`. Decide-and-document:
if `onAlarm` throws, **rethrow** so workerd's built-in alarm retry (with
backoff) kicks in — the scheduler is no-backfill and re-arms from persisted
rows, so a retried alarm is safe. Contract test: alarm fires → `onAlarm` runs
→ scheduler dispatches the due schedule and re-arms the next one, verified
via `runDurableObjectAlarm`.

## 4. Connections — hibernatable WebSockets

`DurableConnection` wraps a server-side `WebSocket`; `DurableConnectionRegistry`
wraps `ctx.getWebSockets()`. Design points:

- **Connection id**: reuse the client-supplied `?_pk=` query param when
  present (partysocket-compatible), else `crypto.randomUUID()`.
- **Accept with a tag**: `ctx.acceptWebSocket(server, [connectionId])` so
  `registry.get(id)` is `ctx.getWebSockets(id)[0]`.
- **The `state` bag** (`Connection.state`) maps to
  `serializeAttachment`/`deserializeAttachment` (attachment shape
  `{ id, state }`). The port exposes a mutable `Record<string, unknown>`;
  the adapter re-serializes the attachment on mutation (a `Proxy` or explicit
  setter — implementer's choice, but writes must survive hibernation).
  Document the 2 KiB attachment limit.
- **Reconstructible from the socket alone**: the registry wraps
  `ctx.getWebSockets()` lazily on every call — no cached socket list — so it
  is correct across hibernation by construction.
- **Hibernation is just eviction**, which the rebuild already survives:
  the event log is durable, connect-sync/resume is offset-driven, and
  `attachChatTransport` is re-attached on every activation (§5). A socket
  woken from hibernation never re-runs `onConnect` — correct, because the
  client was already synced and a DO only hibernates when no events are
  flowing; anything the client *did* miss is served by the existing
  resume-from-offset handshake.
- `broadcast(message, exclude)` iterates `ctx.getWebSockets()` skipping
  excluded ids, `try/catch` per socket (a closing socket must not break the
  fan-out — same behavior the memory registry has).

## 5. The shell: `hostAgent(AgentClass, options)` → a DO class

The one genuinely new component. A mixin factory returning a
`DurableObject` subclass, so users write:

```ts
export class MyAssistant extends Think<Env, MyState> { ... }
export const MyAssistantDO = hostAgent(MyAssistant, {
  model: (env) => anthropicModel(env.ANTHROPIC_API_KEY),
  // spawner/workflows/email wiring, readonly policy, etc.
});
```

Responsibilities (and *only* these — no business logic):

1. **Construct the `AgentHost`** from `ctx`/`env`: scoped
   `DurableKeyValueStore`, `DurableAlarmTimer`, `Date.now` clock,
   `crypto.randomUUID` ids, optional spawner/email/workflows from options,
   `parentPath` from spawn metadata (§6), `onDestroyed` →
   close all sockets + `ctx.storage.deleteAll()` + delete alarm +
   `ctx.abort()`.
2. **Identity.** `ctx.id.name` is not available inside the DO, so
   `host.name` resolves in order: the persisted `meta:name` row → the
   `x-agent-name` header stamped by the router (persisted on first sight) →
   facet spawn metadata (§6) → `ctx.id.toString()` as last resort.
   Alarm-woken instances therefore read the persisted row; a DO that has
   never seen a named request falls back to its hex id.
3. **Activation**: lazily on first entry (any of `fetch` / hibernation
   handlers / `alarm`): `blockConcurrencyWhile` → restore the alarm mirror →
   construct the agent → `agent.start()` (exactly once per activation — the
   invariant every e2e depends on) → `attachChatTransport` over the
   connection registry. Lazy (not constructor-time) because the first-ever
   request may carry the name header the host needs.
4. **`fetch()`**: WebSocket upgrade → `new WebSocketPair()`, accept
   hibernatable with the connection id (§4), run the transport's
   `onConnect`; non-upgrade HTTP → a small typed surface (health, and the
   submissions HTTP entry point if the user opts in) — *not* a general
   RPC-over-HTTP layer in this wave.
5. **Hibernation handlers**: `webSocketMessage` → `transport.onMessage`,
   `webSocketClose`/`webSocketError` → `transport.onClose`. The transport
   instance is created at activation, so a wake-from-hibernation message
   flows through a freshly attached transport with zero special-casing.
6. **`alarm()`** → `agent.onAlarm()` (mirror-clear + rethrow policy per §3;
   child-alarm dispatch per §6).

Plus a worker-level router, deliberately minimal and compatible with the
original URL convention so existing clients keep working:
`routeAgentRequest(request, env, { prefix = "agents" })` maps
`/{prefix}/:kebab-class/:name` → DO namespace binding (matched
case-insensitively against kebab-cased binding names) → named stub →
stamp `x-agent-name` → `stub.fetch(request)`; and
`getAgentByName(namespace, name)` for server-side callers. No partyserver
dependency — that's the transport-coupled layer the rebuild exists to shed.

## 6. `AgentSpawner` — facets, with a root-multiplexed alarm

Delegation's contract (`ports/agent-spawner.ts`): lazily get a handle;
`call(method, args)`, `abort()` (kill instance, keep storage), `destroy()`
(wipe storage). **Decision: facets** — colocated children, and the handle
contract maps 1:1 (`abort` and `delete` are literally the facet API:
`ctx.facets.get(key, () => ({ class: ctx.exports[className], id }))` /
`ctx.facets.abort(key, reason)` / `ctx.facets.delete(key)`, with facet key
`` `${className}\0${name}` ``). Caveats accepted: experimental compatibility
flag, and **facets have no independent alarm slot**.

That forces the one real design in this wave — a **virtual `AlarmTimer` for
children**. The root's shell keeps a `facet-alarm:` row per child (child
path → requested wake time), sets its own physical alarm to
`min(own, all children)`, and on `alarm()` dispatches `onAlarm()` into each
due child facet (waking it if idle) before/after its own. This lives
entirely in `adapters/cloudflare/` — the child agent sees an ordinary
`AlarmTimer`. It must be specced with the same care as a domain module: the
multiplexing rows are the root's, written through the root's store under an
adapter-owned prefix, and torn down on child `destroy()`. (W3 gets a short
spec addendum pinning the row format and dispatch order before
implementation.)

`AgentHandle.call(method, args)` → facet stub method invocation; the shell
exposes the agent's public methods over the stub (an explicit allowlist
mirroring the `CallableRegistry` plus the delegation-required surface —
never blind `(stub as any)[method]`).

`parentPath` and the child's `name` flow to the child at spawn (facet
startup metadata / an idempotent init call before first use), satisfying
`AgentHost.parentPath` and §5's identity chain.

## 7. Capability bindings — thin, mechanical

- **`WorkflowsRuntime`**: constructed with `Record<string, Workflow>` (names
  → env bindings). `create` → `binding.create({ id, params })`; everything
  else → `binding.get(id)` then the 1:1 instance method (`status`, `pause`,
  `resume`, `restart`, `terminate`, `sendEvent`). Unknown name → typed error;
  not-found instance → `null` status per the port.
- **`SendEmailTransport`**: over an Email Workers send binding. Build the
  MIME message with `mimetext` (from/to/subject, text and/or html parts,
  extra headers, generated Message-ID), wrap in `EmailMessage` from
  `cloudflare:email`, `await binding.send(...)`, return `{ messageId }`.
  Inbound email→agent routing is out of scope for this wave. Tests use a
  stub binding object (miniflare's send_email simulation is not assumed);
  assert MIME structure and addressing.
- **Service-binding `FetchLike`**: per §1, a wrapper; ship it alongside the
  global-fetch one so the fetch tool's allowlist logic (domain) is reusable
  over either.

## 8. Packaging & tooling

In-tree, not a sub-package — but strictly config-partitioned:

- Code: `rebuild/src/adapters/cloudflare/**` (plus `facets.d.ts` ambient
  declarations). Workers tests + test worker: `rebuild/test-workers/**`
  (own tiny worker entry defining the test DO classes).
- **TypeScript**: base `tsconfig.json` excludes both dirs; a new
  `tsconfig.cloudflare.json` includes them with
  `types: ["@cloudflare/workers-types"]` and no node globals. `npm run
  typecheck` runs both projects. This keeps DOM/workers globals out of the
  domain build.
- **Vitest**: node config unchanged (`src/**/*.test.ts`); new
  `vitest.workers.config.ts` using the `cloudflareTest` vite plugin
  (pool-workers 0.16's API; `defineWorkersConfig` is gone) +
  `wrangler.jsonc` (compatibility date + flags per §0, the facets
  experimental flag, DO bindings + `new_sqlite_classes` migrations — facet
  child classes bound but not sqlite-migrated), including only
  `test-workers/**/*.test.ts`. **Bump rebuild's vitest ^3 → 4.1.x** to match
  the proven pairing with `@cloudflare/vitest-pool-workers` ^0.16.20; the
  node suite must pass unchanged after the bump (do this first, as its own
  commit).
- Deps: devDeps `wrangler` pinned 4.105.0 (newer wrangler wants
  workers-types v5; 4.105.0 is what pool-workers 0.16.20 itself pins),
  `@cloudflare/vitest-pool-workers` 0.16.20, `@cloudflare/workers-types`
  ^4.20260629; dependency `mimetext` ^3.
- Scripts: `test` (node, unchanged), `test:workers`, `test:all`,
  `demo:cf` (`wrangler dev --config demo/cloudflare/wrangler.jsonc`).

## 9. Test strategy — three layers

1. **Port contract suites (the faithfulness proof).** Extract the existing
   storage/alarm behavioral tests into exported, factory-parameterized
   suites (`describeKeyValueStoreContract(makeStore)`). Run them (a) in the
   node suite against the memory adapters — coverage unchanged — and (b) in
   workerd against real `ctx.storage` via `runInDurableObject`. Any
   divergence is a bug in *our understanding*, found here instead of in
   production.
2. **Shell lifecycle tests** (workerd): start-once per activation; alarm →
   `onAlarm` → scheduler dispatch (`runDurableObjectAlarm`); destroy wipes
   storage and detaches; "eviction" via vitest-pool-workers isolated
   storage + fresh stubs re-running the durable-work story (schedules,
   fibers, queue) on real persistence.
3. **WebSocket integration + one e2e** (workerd): upgrade via `SELF.fetch`,
   drive real `cf_agent_*` frames from the client half of the pair against a
   FakeModel-wired `Think` test subclass; assert connect-sync, streaming,
   state round-trip with origin echo-exclusion between two sockets,
   readonly rejection, resume-from-offset after reconnect. One
   kill-and-recover chat e2e caps the wave. Real-model tests stay out of CI
   (the demo covers visceral verification).

## 10. Waves

- **W1 — substrate**: vitest bump (own commit); tooling scaffold (§8);
  `DurableKeyValueStore` + `DurableAlarmTimer`; contract-suite extraction;
  contracts green in workerd.
- **W2 — hosting**: shell (`hostAgent`) + router + hibernatable
  connections; lifecycle tests; WS integration tests; chat e2e.
- **W3 — delegation**: facet spawner + virtual child alarm + handle-call
  surface; delegation e2e (parent dispatches colocated child, relay,
  reconcile-on-restart). Spec addendum first (§6).
- **W4 — capabilities + demo**: workflows/email/service-binding adapters;
  the demo worker at `rebuild/demo/cloudflare/` — `worker.ts` exporting
  `hostAgent(DemoThink)` (same offline scripted model as `demo/cli.ts`;
  Anthropic via secret when set) + router, and a dependency-free
  `public/index.html` chat page speaking `cf_agent_*` over a WebSocket.
  `npm run demo:cf`.

## 11. Process

Tooling scaffold (W1's first half) is done by the orchestrator directly —
fiddly config with tight feedback loops. Implementation waves run through
**`codex exec`** (gpt-5.5, the configured default): each wave is dispatched
by a thin wrapper subagent (`model: sonnet`, low effort) whose job is to
compose a self-contained codex prompt — the relevant sections of this doc
plus the exact port/app signatures involved — run `codex exec` via Bash from
`rebuild/`, and return codex's report. Clean-room discipline unchanged:
implementers work only from this spec and the `rebuild/` tree — never
`packages/think/`, `packages/agents/`, or `docs/`; Cloudflare's public docs
are fair game. The orchestrator reviews, integrates, and owns all git
operations. W2 and W3 each get a short spec addendum before implementation
(frame-level shell behaviors; virtual-alarm row format).
