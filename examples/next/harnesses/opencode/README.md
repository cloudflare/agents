# OpenCode harness

An experimental example that runs OpenCode's embedded server inside a plain
Durable Object, composed from the SDK's Lifecycle capabilities — the same
shape as the [pi harness](../pi/README.md), with the third-party runtime
swapped out.

That swap is the whole point. If the `agents/state-machine` component really
does make it easier to deploy a durable third-party harness to Workers, then
a second harness should drop into the pattern without inventing a new
integration story. This example is the test of that claim, and it mostly
holds: the machine definition, the reconciled effect, the intake table, and
the Streams/WebSockets transport all transferred unchanged in shape.

## What this needs from `agents/state-machine`

This example is branched from `state-machine-3` and carries the same three
enabling changes to the component that [#2338][pr] makes, because a wrapped
runtime cannot be written without them:

- `MachineEffectInvocation` gains `input`, typed, so `reconcile` and `cancel`
  can read the effect's durable input. They run after a crash, when the only
  other thing they get is `externalId`; without `input` a runtime has to
  encode what it needs into that string and parse it back.
- `MachineEffectRef` becomes a type alias so it satisfies `MachineJson`, and
  a machine can therefore store its own effect handle in its own checkpoint.
  A runtime that parks between passes has to do exactly that.
- `MachineJson` accepts `readonly` arrays and objects, so a caller's own
  immutable types satisfy it without casting.

That two independent harnesses both need precisely these three is, in itself,
evidence they belong in the component rather than in either example.

[pr]: https://github.com/cloudflare/agents/pull/2338

## The composition

```ts
export class OpenCodeAgent extends DurableObject<Env> {
  readonly streams = new Streams();

  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    agent: "build",
    config: { model: "anthropic/claude-sonnet-4-5" }
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.stateMachine)
    .use(this.webSockets)
    .use(this.harness);
}
```

Line for line the same as the pi example. `OpenCodeHarness` owns its
`StateMachine` rather than receiving one, because the definition and its
effect runtime are bound to that harness's OpenCode host.

## Why a wrapped runtime, not a native machine

OpenCode is already a durable state machine. Its `workerd` profile puts the
database on the Durable Object's SQLite, persists durable events for eviction
recovery, and replays a suspended session on boot through a write-ahead
execution claim. Re-expressing its step and tool phases as `StateMachine`
phases would create two authorities for the same effects.

So this uses the second integration shape from the state-machine design: a
**durable runtime wrapper**. Each turn is one machine run whose checkpoint
holds only admission data and a handle to the current drive pass. The pass is
an effect with `recovery: "reconcile"`, keyed by the turn's own operation id:

```text
admit ──▶ drive ──▶ (settled) ──▶ complete
             │
             └────▶ (waiting) ──▶ waiting ──▶ drive …
```

After an eviction the machine does not re-send the prompt. It asks OpenCode,
through `message.list()` and `sessions.active()`, what actually happened:

| OpenCode's record            | Reconciled as | The machine then       |
| ---------------------------- | ------------- | ---------------------- |
| completed assistant reply    | `completed`   | settles the run        |
| session still running        | `running`     | parks and re-checks    |
| user message never landed    | `not-found`   | reports it interrupted |

A permission prompt and a long tool call both surface as `waiting`, so a turn
parks on a durable deadline instead of holding a Durable Object invocation
open.

## How it maps to pi

The two harnesses are structurally identical; only the authority's API
differs. That correspondence is the evidence the component generalises.

| Concern              | pi                                | OpenCode                                     |
| -------------------- | --------------------------------- | -------------------------------------------- |
| Attach to DO SQLite  | `SqliteStorage` + `do-sqlite.ts`  | `OpenCodeWorkerd.create({ storage })`         |
| Admit a turn         | `lane.accept(request)`            | `sessions.prompt({ id: msg_<op> })`           |
| One bounded pass     | `lane.drive({ operationId })`     | `sessions.wait()` + pass budget               |
| Terminal record      | `lane.getResult(operationId)`     | completed assistant reply after `msg_<op>`    |
| Liveness             | `lane.inspectExecution()`         | `sessions.active()`                           |
| Durable abort        | `lane.requestAbort()`             | `sessions.interrupt()`                        |
| Steering             | `lane.steer(text)`                | `sessions.prompt({ delivery: "steer" })`      |
| Live events          | `harness.events.on(type)`         | `events.subscribe()` async iterable           |
| Recovery on boot     | `AgentHarness.create()` → `open`  | boot-time replay of the execution claim       |

Notably, **OpenCode needed one thing pi did not**: an explicit pass budget.
Pi's `drive()` returns when it has something to report. OpenCode's
`sessions.wait()` resolves only when the session goes idle, which can exceed a
Durable Object invocation, so `#waitForIdle` races it against a wall-clock
budget and returns `waiting/"budget"`. The machine already had the vocabulary
for that — it is the same park the pi harness uses for retry backoff — which
is a good sign for the component.

Conversely, OpenCode has a first-class concept pi lacks: **permissions**.
`permission.asked` parks the run on a `oc:permission-replied` event with a
long timeout, and `replyPermission()` notifies it. This slotted into
`context.wait()` without changing the machine's shape.

## Admission and cancellation

`submit()` writes a row to a small intake table _before_ it starts the machine
run, so a crash between the two is repaired on the next wake: startup pushes a
reconcile job that re-runs `StateMachine.run()` for every queued submission,
and `run()` is idempotent on the operation id.

The user message id is derived from the operation id (`msg_<operationId>`), so
a redelivery after a crash is OpenCode's own duplicate rather than a second
turn — this is what stands in for pi's admission dedupe.

Cancellation is durable on both sides: OpenCode records its interrupt and the
machine run is cancelled, so no further pass is admitted. The machine declares
no `onCancel`, so `StateMachine` settles it natively as `cancelled` and the
outer control state agrees with OpenCode's record.

## Measured viability

Probed against `@opencode/sdk@2.0.15` with the SDK's own documented bundle
command (`esbuild --conditions=workerd --platform=node`):

| Metric                   | Value    | Verdict                                    |
| ------------------------ | -------- | ------------------------------------------ |
| Bundles under `workerd`  | yes      | 0 unresolved imports                       |
| Uncompressed bundle      | 13.2 MB  | under the 64 MiB Worker limit              |
| Gzipped                  | 2.9 MB   | no longer a limit (removed 2026-09-04)     |
| Largest input            | 5.9 MB `@opencode/core` | dominates; `effect` adds 0.76 MB |

So it deploys — but 13.2 MB is roughly **50× the pi harness**, and bundle size
is the main driver of Worker startup time. This is the number to watch before
calling the approach production-ready. Realistic mitigations: OpenCode's
provider list (`venice-ai-sdk-provider`, `gitlab-ai-provider`, `openai`,
`@smithy/*`) and its npm/tar/glob surface are all reachable from the graph
even though the workerd profile cannot use most of them, so a `workerd`-
conditioned pruning pass upstream would likely cut this hard.

## What does not work under the workerd profile

The SDK is explicit that the Durable Object has no execution plane. Bare
locations get a no-execution process spawner; `FileSystem`, `FileSystemSearch`
and `Pty` fail with a clear defect; `Snapshot` and `Vcs` degrade to no-ops;
stdio MCP reports the same failure as Shell. So the bash/edit/read tools that
make OpenCode a *coding* agent are unavailable until a remote sandbox backs
them — which is exactly the gap a Cloudflare Sandbox or Container binding
would fill, and the most interesting follow-on to this PoC.

`src/server.ts` therefore denies `bash` and `edit` in config rather than
letting them fail at call time.

## Layout

```
src/
  server.ts                    the Durable Object and its Lifecycle composition
  harness/
    opencode-harness.ts        the LifecycleCapability: boot, submit, drive, settle
    machine.ts                 the durable turn machine (admit → drive → waiting)
    drive-runtime.ts           the reconcile/cancel effect runtime
    intake.ts                  durable submission queue
    events.ts                  V2Event projection + chunked stream writer
    messages.ts                transcript projection
    settlement.ts              wakes callers waiting on a turn
    transport.ts               the WebSocket protocol over Streams
    types.ts                   the example's stable OC* surface
```

## Status

**Typechecks clean** (`tsc --noEmit`, 0 errors) against the `agents` build
from the PR branch and the real `@opencode/sdk@2.0.15` types, and the
OpenCode graph **bundles clean** under the `workerd` condition. Not yet run
end to end.

Getting the types to pass caught four wrong guesses about the OpenCode API
that a design sketch would have shipped:

- `permission.reply` takes `{sessionID, requestID, decision}`, not
  `{permissionID, reply}`.
- `sessions.prompt` has **no** `agent` field — the agent is session state,
  selected with `sessions.switchAgent` before delivery.
- `sessions.command` takes `{name, text}`, not `{command, arguments}`.
- `sessions.skill` takes `{id}`, and `compact` accepts a message `id`.

The remaining work is a `vitest-pool-workers` test mirroring the pi
example's: drive a turn to settlement with a faux provider, evict the object,
and check the transcript and a second turn survive.

## Verify

```sh
pnpm install
pnpm typecheck
```
