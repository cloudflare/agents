# Agent is the substrate; Think is a composition over it (no privileged access)

**Status: implemented (verified 2026-07-15).** `Think` uses only `Agent`'s
public and `protected` surface — no `private` access, no `super.*` beyond a
normal `destroy()` override, no escape-hatch casts. Therefore Think is
reproducible in userland: a developer can write their own Think-equivalent
(or a leaner/different composition) by extending `Agent` and composing the
same domain modules, with exactly the access Think has. There is nothing
magic about Think — it is one composition among possible many.

## The boundary, stated

**`Agent` = the durable, transport-free runtime substrate.** It owns the
platform-agnostic primitives every durable agent needs, and nothing about
conversation:

- identity — `host`, `name`, `ids` (public readonly)
- observable state — `setState` / `state` (private `stateContainer`)
- the single-alarm **scheduler** — `schedule` / `scheduleEvery` / `cancelSchedule`
- durable execution (**fibers**) — `startFiber`
- **keep-alive** ref-counting — `keepAlive`
- the durable **task queue** — `queue`
- **RPC / callables** — `callables`
- sub-agent **spawning** and **workflow** tracking
- the outbound **event log** — `events()` (public read) / `publishEvent` (emit)
- lifecycle — `start` / `onAlarm` / `destroy`

Plus a deliberate **extension contract** — the `protected` members a
composition-on-Agent builds against (audit 26 §5):

| protected seam | what a composition uses it for |
|---|---|
| `publishEvent(event)` | emit domain events onto the outbound log |
| `schedulerService` | schedule its own timers (recovery, tasks) |
| `fiberService` | wrap work in recoverable durable fibers |
| `keepAliveService` | hold the DO awake across async work |
| `registerInternalCallback(name, fn)` | name a callback the scheduler/queue can dispatch |
| `host.store` (scoped) | its own prefixed slice of storage |

**`Think` = one composition over `Agent`.** It adds a conversational turn
engine by wiring together *isolated, independently-tested domain modules* —
the turn loop, session/history, tools + actions, chat recovery + overflow
guard, submissions, channels, delegation-as-tools, conversation turn-state /
continuation — and connecting them to the substrate: emitting conversation
events via `publishEvent`, running recoverable turns on `fiberService`,
scheduling continuations and declared tasks via `schedulerService` +
`registerInternalCallback`, storing module state in scoped `host.store`.
Think's own file is thin wiring; the heavy logic lives in the modules (each an
exported `create*(deps)` factory) and in the Agent substrate.

## The evidence (why this is not aspirational)

Grep of `src/app/think.ts` against `src/app/agent.ts` (2026-07-15): every
`Agent` member Think touches is public or `protected` —
`host`/`bus`/`ids`/`events()` (public), `publishEvent`/`schedulerService`/
`fiberService`/`registerInternalCallback` (protected), and `super.destroy()`
(ordinary override). Think references **none** of Agent's `private` fields
(`taskQueue`, `stateContainer`, `subAgents`, `workflows`, `callableRegistry`,
`eventLog`, `dispatchSchedule`, `dispatchQueue`), and contains no
`(this as any)` / `as unknown as` / `@ts-` bypass. TypeScript's `private`
already prevents a userland author from reaching less than Think reaches — so
the reproducibility is enforced, not merely observed.

## Why enshrine it

The Agent/Think difference was unstated and caused confusion (e.g. treating
"chat" as an agent *type* — see ISSUE-030). Naming the boundary makes the
architecture legible and gives it a testable invariant:

**Invariant: Think must build only on Agent's public + protected surface.** If
Think ever needs something Agent keeps `private`, the fix is to *promote it
into the extension contract* (make it `protected` and document it here), never
to special-case Think. That keeps "write your own Think in userland" true by
construction, and keeps Agent an honest, reusable substrate rather than a
Think implementation detail.

## Consequence / open follow-up

Reproducible-in-userland is **true today but not yet first-class DX.** The
extension contract works but is documented only here; the domain-module
factories are public and test-proven but their `{ store, clock, ids, bus, … }`
dep signatures are internal-facing. Making "compose your own agent" an
*advertised* path (a cookbook + ergonomic composition surface) is the
companion DX work noted in audit 30 and ISSUE-030 — the architecture already
permits it; only the packaging is missing.
