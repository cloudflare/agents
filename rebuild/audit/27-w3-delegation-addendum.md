# 27/W3 addendum — facet spawner + root-multiplexed child alarm

Pins audit 27 §6 to implementation level. Scope: `src/adapters/cloudflare/`
`facets.d.ts`, `spawner.ts`, shell alarm-mux changes in `shell.ts`, workerd
tests. Frozen list unchanged (domain/ports untouched; W1 `store.ts`/`alarm.ts`
untouched).

## 0. Phase 1 — platform probes (do this FIRST, report before building on it)

Facets are experimental and not in workers-types. Before implementing, add
`test-workers/facets-probe.test.ts` asserting what the rig's runtime actually
provides (these stay in the suite as living platform facts):

1. `ctx.facets.get(key, () => ({ class: ctx.exports.SomeExportedClass }))`
   returns a stub whose RPC methods work. (Also probe whether an `id` field in
   the startup options is required/accepted.)
2. A function passed as an RPC argument to the facet is callable from inside
   the child (workers RPC auto-stubs functions) — this is what makes the
   delegation relay possible across the boundary.
3. The facet has its own isolated storage (`ctx.storage.kv` writes in the
   child are invisible to the root and vice versa).
4. Alarm capability probe: does `ctx.storage.setAlarm(...)` in a facet
   resolve, and does `getAlarm()` read it back? (Even if it resolves, facet
   alarm DELIVERY is presumed absent — `runDurableObjectAlarm` only targets
   real stubs. The virtual mux below is the dependable path regardless;
   record the probe result in a comment.)

If probe 1 or 2 fails outright (facets unsupported in this workerd), STOP and
report — the wave falls back to a different substrate and needs re-planning.

## 1. `facets.d.ts` — ambient declarations

Declare exactly what we call, on `DurableObjectState`:

```ts
interface FacetStartupOptions { class: unknown; id?: DurableObjectId }
interface DurableObjectFacets {
  get(name: string, getStartupOptions: () => FacetStartupOptions | Promise<FacetStartupOptions>): any;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void | Promise<void>;
}
// augment DurableObjectState with: facets: DurableObjectFacets; exports: Record<string, unknown>;
```

Adjust to what the probes reveal; the declarations must reflect runtime
reality, not aspiration.

## 2. `__call` on the shell (audit §6's explicit surface)

`hostAgent` gains RPC method `__call(method: string, args: unknown[])`:
dispatches to the agent instance ONLY if the method name is in the allowlist:
the union of (a) the agent's `callables()` registry names, and (b) a fixed
`DELEGATION_SURFACE` constant — derive its members from what
`src/domain/delegation/` actually invokes on handles/children (grep
`.call(` there) plus the drill-in/reconcile surface, each listed explicitly
in the code. Unknown/underscore-prefixed/non-function names → throw
`NotFoundError` (`src/kernel/errors.js`). Return value passes through as-is
(functions inside args arrive as RPC stubs; pass them along untouched).

## 3. `spawner.ts` — `createFacetSpawner`

```ts
export function createFacetSpawner(deps: {
  ctx: DurableObjectState;
  selfPath: Array<{ className: string; name: string }>;   // root-first, incl. self
  /** Called by the shell so the spawner can trigger a re-arm after child alarm changes. */
  arm: (facetKey: string, at: number | null) => void;
}): AgentSpawner;
```

- Facet key: `` `${className}\0${name}` ``. Class from `ctx.exports[className]`
  (missing → `NotFoundError`).
- `get(className, name)` is sync per the port: it returns an `AgentHandle`
  that lazily performs, before the first RPC of this activation:
  `stub.__init({ name, parentPath: selfPath, facetHosted: true })` (idempotent
  — see W2 `__init`; extend it to persist a `cf-shell:facet-hosted` flag) and
  `stub.__link({ armChild })` where `armChild = (at) => deps.arm(facetKey, at)`.
  Memoize the init promise; `call`/`destroy` await it.
- `AgentHandle.call(method, args)` → `stub.__call(method, args)`.
- `abort(reason)` → `ctx.facets.abort(facetKey, reason)` (drop the memoized
  init so the next call re-links).
- `destroy()` → `await stub.__destroy()`, `await ctx.facets.delete(facetKey)`,
  `deps.arm(facetKey, null)`.

## 4. Child-side virtual alarm (shell changes, facet mode)

When the persisted `cf-shell:facet-hosted` flag is set, the shell's activation
builds a **virtual** timer instead of `createDurableAlarmTimer`:

- `set(at)`: mirror = at; persist `cf-shell:alarm-request` row; push
  `armChild(at)` if a link is present (in-memory stub from `__link`).
- `clear()`: mirror = null; delete the row; push `armChild(null)`.
- `get()`: mirror. `flush()`: resolved promise. `onPlatformAlarm()`: as W1
  (capture mirror, null it, delete the row).
- Never touches `ctx.storage.setAlarm`.

New RPC methods on the shell (all modes, but only meaningful for facets):
- `__link(link: { armChild: (at: number | null) => void })`: stores the stub
  in memory for this activation; immediately pushes the current request row
  (covers re-activation with a pending alarm).
- `__alarm(): Promise<number | null>`: ensure → virtual
  `onPlatformAlarm()` → `agent.onAlarm()` → return `timer.get()` (the child's
  next requested time, so the root can update its row without a second RPC).

## 5. Root-side alarm mux (shell changes, all modes)

The root shell owns the single physical slot. Replace the direct wiring:

- The physical `DurableAlarmTimer` (W1) becomes shell-internal. The AGENT
  receives an **own-view** timer: `set/clear` update mirror + a
  `cf-shell:alarm-own` row, then call `rearm()`; `get()` reads the own
  mirror; `flush()` delegates to the physical timer's flush.
- Child rows: `cf-shell:child-alarm:<facetKey>` → requested epoch ms,
  written by `arm(facetKey, at)` (delete on null), which then calls `rearm()`.
- `rearm()`: physical slot = min(own row, all child rows); none → physical
  `clear()`.
- Platform `alarm()` handler: physical `onPlatformAlarm()`; `now = Date.now()`;
  if own row due (`<= now`): clear own row, `agent.onAlarm()` (which may
  re-set the own view); for each due child row in ascending time then key
  order: `next = await childStub.__alarm()`, update that row from `next`.
  Child stubs are re-obtained via `ctx.facets.get` with the same startup
  options (persist per-child class names under the row, or encode className
  in the facetKey — the key already contains it). Finally `rearm()` and
  physical `flush()`.
- **Behavioral compatibility**: with no children (no child rows), this must
  be observably identical to W2 — the existing `chat.test.ts` and
  `alarm.test.ts` pass unchanged.

Known accepted limitation (document in `spawner.ts` header): a child that
schedules while the root is mid-eviction, or whose `armChild` push is lost,
is re-synced at the next quiescence point (`__alarm` return or any
`handle.call`) — at-least-once, no-backfill, same doctrine as the scheduler.

## 6. W3 workerd tests (beyond the §0 probes)

Test worker: add a `ChildAgent extends Think` (scripted model) exported via
`hostAgent`, bound in wrangler.jsonc (binding required for `ctx.exports`;
per audit §0 facet children stay OUT of `new_sqlite_classes` — if the probe
shows storage/SQL breaks without it, add it and report). Root test agent
gains a spawner via the shell.

1. Two child names → isolated storage; same name twice → same instance.
2. Child agent sees `parentPath` = root's path (assert via `__call`).
3. `__call` allowlist: delegation-surface method works; `_private` and
   unknown names rejected.
4. Streaming relay across the boundary: parent invokes child `chat` with a
   callback relay (functions-as-args); parent collects streamed events.
5. Child alarm mux end-to-end: child schedules (injected-clock pattern from
   W2 chat tests) → root's physical slot arms at the child's time →
   `runDurableObjectAlarm(rootStub)` → child callback ran → slot re-armed or
   cleared per remaining rows.
6. Min-of-both: root schedules later + child earlier → slot at child's time;
   after the child fires, slot moves to the root's own time.
7. `destroy()`: child storage wiped (fresh handle sees none), child row gone,
   slot recomputed. `abort()`: in-memory dropped, storage retained.
